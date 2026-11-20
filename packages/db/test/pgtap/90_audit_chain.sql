-- The audit chain (migration 0013, docs/adr/0033). A trigger chains every audit_log row per
-- workspace with SHA-256 and overwrites whatever the app sends for the chain columns; the app
-- still can't change or remove a row; audit_chain_verify finds edits, deletions, and reordering
-- by the owner; and checkpoints are append-only for the app and isolated by RLS. Ids come from
-- test/fixtures/two-workspaces.sql, where each workspace's seeded entry is chain_seq 1.
begin;
select plan(50);

-- The trigger and functions themselves (10)
select has_trigger('public', 'audit_log', 'audit_log_chain', 'audit_log has the chaining trigger');
select trigger_is('public', 'audit_log', 'audit_log_chain', 'public', 'audit_log_chain',
  'the trigger runs audit_log_chain()');
select is(
  (select row(t.tgenabled, (t.tgtype & 2) <> 0, (t.tgtype & 4) <> 0, (t.tgtype & 1) <> 0)::text
   from pg_trigger t where t.tgname = 'audit_log_chain'),
  row('O', true, true, true)::text,
  'it is enabled, BEFORE, on INSERT, and FOR EACH ROW'
);
select is(
  (select row(p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner))::text
   from pg_proc p where p.oid = 'public.audit_log_chain()'::regprocedure),
  row(true, array['search_path=pg_catalog, pg_temp'], (select pg_get_userbyid(relowner)
    from pg_class where oid = 'public.audit_log'::regclass))::text,
  'audit_log_chain is SECURITY DEFINER, owned by the table owner, with search_path pinned'
);
select is(
  (select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('audit_entry_canonical', 'audit_log_chain', 'audit_chain_verify')
     and not p.prosecdef
     and p.proconfig = array['search_path=pg_catalog, pg_temp']),
  array['audit_chain_verify(uuid)', 'audit_entry_canonical(audit_log)'],
  'the canonical text and the check are SECURITY INVOKER, with search_path pinned'
);
select is_empty(
  $$select p.proname from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('audit_entry_canonical', 'audit_log_chain', 'audit_chain_verify')
      and (p.proacl is null or exists (select from aclexplode(p.proacl) a where a.grantee = 0))$$,
  'PUBLIC can execute none of the chain''s functions'
);
select is(
  array[
    has_function_privilege('earshot_app', 'public.audit_entry_canonical(public.audit_log)', 'EXECUTE'),
    has_function_privilege('earshot_app', 'public.audit_chain_verify(uuid)', 'EXECUTE'),
    has_function_privilege('earshot_app', 'public.audit_log_chain()', 'EXECUTE')
  ],
  array[true, true, false],
  'earshot_app may build canonical texts and check its chain, but not call the trigger function'
);
select col_not_null('public', 'audit_log', c, format('audit_log.%s is NOT NULL', c))
from unnest(array['chain_seq', 'prev_hash', 'entry_hash']) as c;

-- The canonical text: a fixed rendering, whatever the server's DateStyle, TimeZone, or
-- extra_float_digits (2)
set local DateStyle = 'SQL, DMY';
set local TimeZone = 'America/Los_Angeles';
set local extra_float_digits = 3;
select is(
  public.audit_entry_canonical(r),
  '[1, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 7, "user-a", "proposal.approved", "proposal", '
    || '"a0000000-0000-4000-8000-000000000007", {"a": [1.50, 1000, 0, 0.1, true, null], '
    || '"z": "Ünïcødé ✓ \"quoted\" back\\slash", "ctrl": "tab\tnew\nline\u0001", '
    || '"nested": {"a": [], "b": {}}}, "2026-11-20T10:00:00.123456Z"]',
  'audit_entry_canonical renders a row exactly'
)
from jsonb_populate_record(null::public.audit_log, jsonb_build_object(
  'workspace_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'chain_seq', 7,
  'actor_user_id', 'user-a',
  'action', 'proposal.approved',
  'subject_type', 'proposal',
  'subject_id', 'a0000000-0000-4000-8000-000000000007',
  'detail', '{"z": "Ünïcødé ✓ \"quoted\" back\\slash", "a": [1.50, 1e3, -0, 0.1, true, null],
              "nested": {"b": {}, "a": []}, "ctrl": "tab\tnew\nline\u0001"}'::jsonb,
  'at', '2026-11-20T10:00:00.123456Z'
)) as r;
select is(
  public.audit_entry_canonical(r),
  '[1, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 1, null, "credential.rotated", null, null, {}, '
    || '"1999-12-31T23:59:59.000000Z"]',
  'nulls render as null, and an empty detail as {}'
)
from jsonb_populate_record(null::public.audit_log, jsonb_build_object(
  'workspace_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'chain_seq', 1,
  'action', 'credential.rotated', 'detail', '{}'::jsonb, 'at', '1999-12-31T23:59:59Z'
)) as r;
reset DateStyle;
reset TimeZone;
reset extra_float_digits;

-- As A, through the app role
set local role earshot_app;
select set_config('app.user_id', 'user-a', true),
       set_config('app.workspace_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

-- Whatever the app sends for the chain columns and the time is overwritten (5)
select lives_ok(
  $$insert into audit_log (id, workspace_id, actor_user_id, action, chain_seq, prev_hash, entry_hash, at)
    values ('a0000000-0000-4000-8000-000000000911', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-a',
            'test.forged', 999, '\xdeadbeef', '\xdeadbeef', '2001-01-01T00:00:00Z')$$,
  'A can insert an entry that names its own chain columns and time'
);
select is((select chain_seq from audit_log where id = 'a0000000-0000-4000-8000-000000000911'),
  2::bigint, 'chain_seq is the next seq (2), not the 999 the app sent');
select is((select prev_hash from audit_log where id = 'a0000000-0000-4000-8000-000000000911'),
  (select entry_hash from audit_log where id = 'a0000000-0000-4000-8000-000000000011'),
  'prev_hash is the previous entry''s hash, not what the app sent');
select ok(
  (select at >= now() and at <= clock_timestamp()
   from audit_log where id = 'a0000000-0000-4000-8000-000000000911'),
  'at is the clock when the entry joined the chain, not what the app sent');
select is(
  (select entry_hash from audit_log where id = 'a0000000-0000-4000-8000-000000000911'),
  (select sha256(a.prev_hash || convert_to(public.audit_entry_canonical(a), 'UTF8'))
   from audit_log a where a.id = 'a0000000-0000-4000-8000-000000000911'),
  'entry_hash is SHA-256 of prev_hash and the canonical text, as UTF-8'
);

-- Seqs are consecutive within a workspace (3)
insert into audit_log (workspace_id, actor_user_id, action, detail)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-a', 'test.third', '{"n": 3}'),
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-a', 'test.fourth', '{"n": 4}'),
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-a', 'test.fifth', '{"n": 5}');
select results_eq('select chain_seq, action from audit_log order by chain_seq',
  $$values (1::bigint, 'proposal.approved'), (2::bigint, 'test.forged'), (3::bigint, 'test.third'),
           (4::bigint, 'test.fourth'), (5::bigint, 'test.fifth')$$,
  'A''s seqs run 1 to 5, in insertion order');
select is((select prev_hash from audit_log where chain_seq = 1), decode(repeat('00', 32), 'hex'),
  'the first entry''s prev_hash is 32 zero bytes');
select is(public.audit_chain_verify('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), null,
  'as A, audit_chain_verify finds A''s chain intact');

-- UPDATE, DELETE, and TRUNCATE still fail for the app, on the chain columns too (4)
select throws_ok($$update audit_log set chain_seq = 9 where chain_seq = 5$$,
  '42501', 'permission denied for table audit_log', 'A can''t renumber an entry');
select throws_ok($$update audit_log set entry_hash = prev_hash$$,
  '42501', 'permission denied for table audit_log', 'A can''t rewrite a hash');
select throws_ok($$delete from audit_log where chain_seq = 5$$,
  '42501', 'permission denied for table audit_log', 'A can''t delete its newest entry');
select throws_ok('truncate audit_log', '42501', 'permission denied for table audit_log',
  'A can''t truncate the chain');

-- Checkpoints: A may append its own and read them, and nothing else (9)
select lives_ok(
  $$insert into audit_checkpoints (workspace_id, chain_seq, entry_hash, signed_at, kid, signature, request)
    select workspace_id, chain_seq, entry_hash, now(), 'audit-test', decode(repeat('01', 64), 'hex'), 'review'
    from audit_log where chain_seq = 5$$,
  'A can append a checkpoint of its head');
select results_eq('select chain_seq from audit_checkpoints order by chain_seq',
  $$values (1::bigint), (5::bigint)$$, 'A reads only its own checkpoints');
select throws_ok($$update audit_checkpoints set kid = 'audit-other'$$,
  '42501', 'permission denied for table audit_checkpoints', 'A can''t change a checkpoint');
select throws_ok($$delete from audit_checkpoints$$,
  '42501', 'permission denied for table audit_checkpoints', 'A can''t delete a checkpoint');
select throws_ok('truncate audit_checkpoints', '42501',
  'permission denied for table audit_checkpoints', 'A can''t truncate the checkpoints');
select throws_ok(
  $$insert into audit_checkpoints (workspace_id, chain_seq, entry_hash, signed_at, kid, signature, request)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1, decode(repeat('00', 32), 'hex'), now(),
            'audit-test', decode(repeat('01', 64), 'hex'), 'review')$$,
  '42501', 'new row violates row-level security policy for table "audit_checkpoints"',
  'A can''t append a checkpoint to B');
select throws_ok(
  $$insert into audit_checkpoints (workspace_id, chain_seq, entry_hash, signed_at, kid, signature, request)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 42, decode(repeat('00', 32), 'hex'), now(),
            'audit-test', decode(repeat('01', 64), 'hex'), 'review')$$,
  '23503', null, 'a checkpoint must name an entry that exists');
select throws_ok(
  $$insert into audit_checkpoints (workspace_id, chain_seq, entry_hash, signed_at, kid, signature, request)
    select workspace_id, chain_seq, entry_hash, now(), 'audit-test', decode(repeat('01', 63), 'hex'), 'review'
    from audit_log where chain_seq = 5$$,
  '23514', null, 'a signature must be 64 bytes');
select lives_ok(
  $$insert into audit_checkpoints (workspace_id, chain_seq, entry_hash, signed_at, kid, signature, request)
    select workspace_id, chain_seq, entry_hash, now(), 'audit-test', decode(repeat('01', 64), 'hex'), 'export'
    from audit_log where chain_seq = 5$$,
  'an account export may sign the head it exports');

-- As B, in the same transaction: B's chain is its own (3)
select set_config('app.user_id', 'user-b', true),
       set_config('app.workspace_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
insert into audit_log (workspace_id, actor_user_id, action)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'user-b', 'test.second'),
       ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'user-b', 'test.third');
select results_eq('select chain_seq from audit_log order by chain_seq',
  $$values (1::bigint), (2::bigint), (3::bigint)$$,
  'B''s seqs run 1 to 3, unaffected by A''s five');
select results_eq('select chain_seq from audit_checkpoints', $$values (1::bigint)$$,
  'B sees only its own checkpoint');
select is(public.audit_chain_verify('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), null,
  'as B, A''s chain is invisible: the check sees no rows to fault');

-- As the owner, who RLS doesn't stop and who can change rows: time only moves forward, and
-- tampering is caught (14)
reset role;
-- Workspaces C to I, each with one member and a chain of four entries, inserted as the owner
insert into "user" (id, name, email)
select 'user-' || w, 'User ' || w, w || '@chain.test'
from unnest(array['c', 'd', 'e', 'f', 'g', 'h', 'i']) as w;
insert into workspaces (id, name)
select (repeat(w, 8) || '-' || repeat(w, 4) || '-4' || repeat(w, 3) || '-8' || repeat(w, 3) || '-' || repeat(w, 12))::uuid,
       'Workspace ' || w
from unnest(array['c', 'd', 'e', 'f']) as w;
insert into workspaces (id, name) values
  ('99999999-9999-4999-8999-999999999999', 'Workspace g'),
  ('88888888-8888-4888-8888-888888888888', 'Workspace h'),
  ('77777777-7777-4777-8777-777777777777', 'Workspace i');
create temp table chain_ws (letter text primary key, id uuid not null) on commit drop;
insert into chain_ws values
  ('c', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'), ('d', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  ('e', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'), ('f', 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
  ('g', '99999999-9999-4999-8999-999999999999'), ('h', '88888888-8888-4888-8888-888888888888'),
  ('i', '77777777-7777-4777-8777-777777777777');
insert into workspace_members (workspace_id, user_id) select id, 'user-' || letter from chain_ws;
insert into audit_log (workspace_id, actor_user_id, action, subject_type, subject_id, detail)
select w.id, 'user-' || w.letter, 'proposal.approved', 'proposal', 'p-' || g, jsonb_build_object('n', g)
from chain_ws w cross join generate_series(1, 4) as g
order by w.letter, g;

select is(
  (select array_agg(public.audit_chain_verify(id) order by letter) from chain_ws),
  array[null, null, null, null, null, null, null]::bigint[],
  'every new chain verifies before anyone tampers with it'
);

-- Time never runs backwards along a chain: the clock is read once the lock is held, and never
-- earlier than the head's (2)
select is_empty(
  $$select from (
      select at, lag(at) over (partition by workspace_id order by chain_seq) as prev_at
      from audit_log
    ) t
    where at < prev_at$$,
  'in every workspace, at never decreases along the chain'
);
update audit_log set at = '2100-01-01T00:00:00Z'
where workspace_id = '77777777-7777-4777-8777-777777777777' and chain_seq = 4;
insert into audit_log (workspace_id, actor_user_id, action)
values ('77777777-7777-4777-8777-777777777777', 'user-i', 'test.after-a-clock-step');
select is(
  (select at from audit_log
   where workspace_id = '77777777-7777-4777-8777-777777777777' and chain_seq = 5),
  '2100-01-01T00:00:00Z'::timestamptz,
  'behind the head, the clock gives way: a new entry takes the head''s time, not an earlier one'
);

-- An edit to any covered column (4)
update audit_log set detail = '{"n": 20}'
where workspace_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' and chain_seq = 2;
select is(public.audit_chain_verify('cccccccc-cccc-4ccc-8ccc-cccccccccccc'), 2::bigint,
  'an edited detail fails the check at its seq');
update audit_log set detail = '{"n": 2}', actor_user_id = null
where workspace_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' and chain_seq = 2;
select is(public.audit_chain_verify('cccccccc-cccc-4ccc-8ccc-cccccccccccc'), 2::bigint,
  'so does a changed actor, even with the detail put back');
update audit_log set actor_user_id = 'user-c', at = at - interval '1 microsecond'
where workspace_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' and chain_seq = 2;
select is(public.audit_chain_verify('cccccccc-cccc-4ccc-8ccc-cccccccccccc'), 2::bigint,
  'so does a time moved by one microsecond');
update audit_log set at = at + interval '1 microsecond'
where workspace_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' and chain_seq = 2;
select is(public.audit_chain_verify('cccccccc-cccc-4ccc-8ccc-cccccccccccc'), null,
  'and putting every value back makes it hold again');

-- A deletion (1)
delete from audit_log where workspace_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' and chain_seq = 2;
select is(public.audit_chain_verify('dddddddd-dddd-4ddd-8ddd-dddddddddddd'), 2::bigint,
  'a deleted entry fails the check at the missing seq');

-- Reordering, by seq or by content (2)
update audit_log set chain_seq = 1000
where workspace_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' and chain_seq = 2;
update audit_log set chain_seq = 2
where workspace_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' and chain_seq = 3;
update audit_log set chain_seq = 3
where workspace_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' and chain_seq = 1000;
select is(public.audit_chain_verify('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'), 2::bigint,
  'swapping two entries'' seqs fails the check at the first of them');
update audit_log a set detail = b.detail, subject_id = b.subject_id
from audit_log b
where a.workspace_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff' and b.workspace_id = a.workspace_id
  and ((a.chain_seq = 2 and b.chain_seq = 3) or (a.chain_seq = 3 and b.chain_seq = 2));
select is(public.audit_chain_verify('ffffffff-ffff-4fff-8fff-ffffffffffff'), 2::bigint,
  'swapping two entries'' contents fails the check at the first of them');

-- A chain rewritten from some entry on, its hashes recomputed so they link up, is caught by a
-- checkpoint signed before the rewrite (2)
insert into audit_checkpoints (workspace_id, chain_seq, entry_hash, signed_at, kid, signature, request)
select workspace_id, chain_seq, entry_hash, now(), 'audit-test', decode(repeat('01', 64), 'hex'), 'review'
from audit_log where workspace_id = '99999999-9999-4999-8999-999999999999' and chain_seq = 3;
do $$
declare
  r audit_log;
  prev bytea;
begin
  for r in select * from audit_log
           where workspace_id = '99999999-9999-4999-8999-999999999999' order by chain_seq loop
    if r.chain_seq = 2 then
      r.detail := '{"n": "rewritten"}';
    end if;
    if r.chain_seq >= 2 then
      r.prev_hash := prev;
      r.entry_hash := sha256(prev || convert_to(public.audit_entry_canonical(r), 'UTF8'));
      update audit_log set detail = r.detail, prev_hash = r.prev_hash, entry_hash = r.entry_hash
      where id = r.id;
    end if;
    prev := r.entry_hash;
  end loop;
end
$$;
select is(
  (select count(*)::int from audit_log a
   where a.workspace_id = '99999999-9999-4999-8999-999999999999'
     and a.entry_hash = sha256(a.prev_hash || convert_to(public.audit_entry_canonical(a), 'UTF8'))),
  4, 'the rewritten chain''s hashes all link up'
);
select is(public.audit_chain_verify('99999999-9999-4999-8999-999999999999'), 3::bigint,
  'but the check fails at the checkpoint that signed the old head');

-- A checkpointed entry can't simply be deleted (1)
insert into audit_checkpoints (workspace_id, chain_seq, entry_hash, signed_at, kid, signature, request)
select workspace_id, chain_seq, entry_hash, now(), 'audit-test', decode(repeat('01', 64), 'hex'), 'flush'
from audit_log where workspace_id = '88888888-8888-4888-8888-888888888888' and chain_seq = 4;
select throws_ok(
  $$delete from audit_log where workspace_id = '88888888-8888-4888-8888-888888888888' and chain_seq = 4$$,
  '23503', null, 'even the owner can''t delete an entry a checkpoint signed, without deleting the checkpoint');

-- Deleting a workspace still removes its chain and checkpoints (1)
delete from workspaces where id = '88888888-8888-4888-8888-888888888888';
select is(
  (select count(*)::int from audit_log where workspace_id = '88888888-8888-4888-8888-888888888888')
  + (select count(*)::int from audit_checkpoints where workspace_id = '88888888-8888-4888-8888-888888888888'),
  0, 'deleting a workspace removes its entries and checkpoints together');

select * from finish();
rollback;
