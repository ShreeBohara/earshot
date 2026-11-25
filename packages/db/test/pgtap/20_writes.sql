-- Writes: as workspace A, earshot_app can write its own rows, but can't insert or update a row
-- into B, can't change or delete B's rows, and can't point a row at one of B's. It can't create,
-- delete, or join workspaces at all, or change or delete a session event: those writes are denied
-- outright (see also 50_workspace_members.sql and 70_session_events.sql).
begin;
select plan(70);

set local role earshot_app;
select set_config('app.user_id', 'user-a', true),
       set_config('app.workspace_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

-- Controls: the same writes succeed for A's own workspace (12; membership is read-only)...
select lives_ok($$update workspaces set name = 'Workspace A, renamed'
  where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$, 'workspaces: A can rename itself');
select lives_ok($$insert into credentials (workspace_id, provider, label, ciphertext, iv, wrapped_dek, dek_iv, last4)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'anthropic', 'work', '\x01', '\x02', '\x03', '\x04', 'wxyz')$$,
  'credentials: A can insert its own row');
select lives_ok($$insert into crm_connections (workspace_id, provider, auth_type, ciphertext, iv, wrapped_dek, dek_iv)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'attio', 'api_key', '\x01', '\x02', '\x03', '\x04')$$,
  'crm_connections: A can insert its own row');
select lives_ok($$insert into crm_entities (workspace_id, kind, external_id, name)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'contact', 'demo-1', 'Dana Lee')$$,
  'crm_entities: A can insert its own row');
select lives_ok($$insert into sessions (workspace_id, user_id, mode, engine)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-a', 'conversation', 'speech-to-speech')$$,
  'sessions: A can insert its own row');
select lives_ok($$insert into session_events (id, workspace_id, session_id, seq, type, schema_version, payload, ts)
  values (gen_random_uuid(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000004',
          1, 'session.ended', 1, '{}', now())$$,
  'session_events: A can append to its own session');
select lives_ok($$insert into utterances (workspace_id, session_id, seq, witness, text, started_ms, ended_ms)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000004',
          0, 'unbiased', 'Met Dana Lee at Acne.', 0, 1800)$$,
  'utterances: A can insert its own row');
select lives_ok($$insert into proposals (workspace_id, session_id, type, target_entity_id, fields)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000004', 'task',
          'a0000000-0000-4000-8000-000000000003', '{}')$$,
  'proposals: A can insert its own row');
select lives_ok($$insert into sync_jobs (workspace_id, proposal_id, review_id, provider,
                                          idempotency_key, not_before)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000007',
          gen_random_uuid(), 'hubspot', repeat('a1', 32), now())$$,
  'sync_jobs: A can insert its own row');
select lives_ok($$insert into commitments (workspace_id, owner, text)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'prospect', 'Loop in legal')$$,
  'commitments: A can insert its own row');
select lives_ok($$insert into facts (workspace_id, entity_id, key, value)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000003', 'stage', '"evaluation"')$$,
  'facts: A can insert its own row');
select lives_ok($$insert into audit_log (workspace_id, actor_user_id, action)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-a', 'credential.added')$$,
  'audit_log: A can append its own entry');

-- ...but renaming is all the app may do to its workspace (1)
select throws_ok($$update workspaces set created_at = now()
  where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$,
  '42501', 'permission denied for table workspaces',
  'workspaces: A can''t change created_at, or any column but name');

-- Inserting a row with B's workspace_id fails: the policy's WITH CHECK, or for workspaces and
-- membership, the missing privilege (13)
select throws_ok($$insert into workspaces (id, name) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Hijacked')$$,
  '42501', 'permission denied for table workspaces',
  'workspaces: A can''t insert a workspace with B''s id (or any workspace)');
select throws_ok($$insert into workspace_members (workspace_id, user_id)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'user-a')$$,
  '42501', 'permission denied for table workspace_members',
  'workspace_members: A can''t insert into B');
select throws_ok($$insert into credentials (workspace_id, provider, label, ciphertext, iv, wrapped_dek, dek_iv, last4)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'anthropic', 'work', '\x01', '\x02', '\x03', '\x04', 'wxyz')$$,
  '42501', 'new row violates row-level security policy for table "credentials"',
  'credentials: A can''t insert into B');
select throws_ok($$insert into crm_connections (workspace_id, provider, auth_type, ciphertext, iv, wrapped_dek, dek_iv)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'attio', 'api_key', '\x01', '\x02', '\x03', '\x04')$$,
  '42501', 'new row violates row-level security policy for table "crm_connections"',
  'crm_connections: A can''t insert into B');
select throws_ok($$insert into crm_entities (workspace_id, kind, external_id, name)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'contact', 'demo-1', 'Dana Lee')$$,
  '42501', 'new row violates row-level security policy for table "crm_entities"',
  'crm_entities: A can''t insert into B');
select throws_ok($$insert into sessions (workspace_id, user_id, mode, engine)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'user-a', 'conversation', 'speech-to-speech')$$,
  '42501', 'new row violates row-level security policy for table "sessions"',
  'sessions: A can''t insert into B');
select throws_ok($$insert into session_events (id, workspace_id, session_id, seq, type, schema_version, payload, ts)
  values (gen_random_uuid(), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b0000000-0000-4000-8000-000000000004',
          1, 'session.ended', 1, '{}', now())$$,
  '42501', 'new row violates row-level security policy for table "session_events"',
  'session_events: A can''t append to B''s session');
select throws_ok($$insert into utterances (workspace_id, session_id, seq, witness, text, started_ms, ended_ms)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b0000000-0000-4000-8000-000000000004',
          0, 'unbiased', 'Called Sam at Atlas.', 0, 1500)$$,
  '42501', 'new row violates row-level security policy for table "utterances"',
  'utterances: A can''t insert into B');
select throws_ok($$insert into proposals (workspace_id, session_id, type, fields)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b0000000-0000-4000-8000-000000000004', 'task', '{}')$$,
  '42501', 'new row violates row-level security policy for table "proposals"',
  'proposals: A can''t insert into B');
select throws_ok($$insert into sync_jobs (workspace_id, proposal_id, review_id, provider,
                                           idempotency_key, not_before)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b0000000-0000-4000-8000-000000000007',
          gen_random_uuid(), 'twenty', repeat('b1', 32), now())$$,
  '42501', 'new row violates row-level security policy for table "sync_jobs"',
  'sync_jobs: A can''t insert into B');
select throws_ok($$insert into commitments (workspace_id, owner, text)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'prospect', 'Loop in legal')$$,
  '42501', 'new row violates row-level security policy for table "commitments"',
  'commitments: A can''t insert into B');
select throws_ok($$insert into facts (workspace_id, entity_id, key, value)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b0000000-0000-4000-8000-000000000003', 'stage', '"lost"')$$,
  '42501', 'new row violates row-level security policy for table "facts"',
  'facts: A can''t insert into B');
select throws_ok($$insert into audit_log (workspace_id, actor_user_id, action)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'user-a', 'credential.added')$$,
  '42501', 'new row violates row-level security policy for table "audit_log"',
  'audit_log: A can''t append to B''s log');

-- Updating one of A's rows to B's workspace_id fails: the policy's WITH CHECK, or the missing
-- privilege (12; audit_log can't be updated at all, see 40_audit_log.sql)
select throws_ok($$update workspaces set id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$,
  '42501', 'permission denied for table workspaces',
  'workspaces: A can''t take B''s id (only name is updatable)');
select throws_ok($$update workspace_members set workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  where workspace_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$,
  '42501', 'permission denied for table workspace_members',
  'workspace_members: A can''t move a member into B');
select throws_ok($$update session_events set workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  where id = 'a0000000-0000-4000-8000-000000000005'$$,
  '42501', 'permission denied for table session_events',
  'session_events: A can''t move an event into B (the log is append-only)');
select throws_ok(format(
  $$update %I set workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' where id = %L$$, t, a_id),
  '42501', format('new row violates row-level security policy for table "%s"', t),
  format('%s: A can''t move its row into B', t))
from (values
  (1, 'credentials', 'a0000000-0000-4000-8000-000000000001'),
  (2, 'crm_connections', 'a0000000-0000-4000-8000-000000000002'),
  (3, 'crm_entities', 'a0000000-0000-4000-8000-000000000003'),
  (4, 'sessions', 'a0000000-0000-4000-8000-000000000004'),
  (5, 'utterances', 'a0000000-0000-4000-8000-000000000006'),
  (6, 'proposals', 'a0000000-0000-4000-8000-000000000007'),
  (7, 'sync_jobs', 'a0000000-0000-4000-8000-000000000008'),
  (8, 'commitments', 'a0000000-0000-4000-8000-000000000009'),
  (9, 'facts', 'a0000000-0000-4000-8000-000000000010')
) as v(ord, t, a_id)
order by v.ord;

-- Updates aimed at B's rows match nothing, or are denied outright (12)
select is_empty($$update workspaces set name = 'Pwned'
  where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' returning id$$,
  'workspaces: A''s update of B changes nothing');
select throws_ok($$update workspace_members set role = 'owner'
  where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  '42501', 'permission denied for table workspace_members',
  'workspace_members: A can''t update B''s member');
select throws_ok($$update session_events set type = 'session.pwned'
  where id = 'b0000000-0000-4000-8000-000000000005'$$,
  '42501', 'permission denied for table session_events',
  'session_events: A can''t update B''s event, or any event');
select is_empty(format($$update %I set %s where id = %L returning id$$, t, change, b_id),
  format('%s: A''s update of B''s row changes nothing', t))
from (values
  (1, 'credentials', 'label = ''pwned''', 'b0000000-0000-4000-8000-000000000001'),
  (2, 'crm_connections', 'status = ''pwned''', 'b0000000-0000-4000-8000-000000000002'),
  (3, 'crm_entities', 'name = ''Pwned''', 'b0000000-0000-4000-8000-000000000003'),
  (4, 'sessions', 'engine = ''pwned''', 'b0000000-0000-4000-8000-000000000004'),
  (5, 'utterances', 'text = ''Pwned''', 'b0000000-0000-4000-8000-000000000006'),
  (6, 'proposals', 'status = ''rejected''', 'b0000000-0000-4000-8000-000000000007'),
  (7, 'sync_jobs', 'attempt = attempt + 1', 'b0000000-0000-4000-8000-000000000008'),
  (8, 'commitments', 'status = ''cancelled''', 'b0000000-0000-4000-8000-000000000009'),
  (9, 'facts', 'key = ''pwned''', 'b0000000-0000-4000-8000-000000000010')
) as v(ord, t, change, b_id)
order by v.ord;

-- Deletes aimed at B's rows match nothing, or are denied outright (12)
select throws_ok($$delete from workspaces where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  '42501', 'permission denied for table workspaces',
  'workspaces: A can''t delete B (which would cascade to all of B''s data), or any workspace');
select throws_ok($$delete from workspace_members
  where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  '42501', 'permission denied for table workspace_members',
  'workspace_members: A can''t remove B''s member');
select throws_ok($$delete from session_events where id = 'b0000000-0000-4000-8000-000000000005'$$,
  '42501', 'permission denied for table session_events',
  'session_events: A can''t delete B''s event, or any event');
select is_empty(format($$delete from %I where id = %L returning id$$, t, b_id),
  format('%s: A can''t delete B''s row', t))
from (values
  (1, 'credentials', 'b0000000-0000-4000-8000-000000000001'),
  (2, 'crm_connections', 'b0000000-0000-4000-8000-000000000002'),
  (3, 'crm_entities', 'b0000000-0000-4000-8000-000000000003'),
  (4, 'sessions', 'b0000000-0000-4000-8000-000000000004'),
  (5, 'utterances', 'b0000000-0000-4000-8000-000000000006'),
  (6, 'proposals', 'b0000000-0000-4000-8000-000000000007'),
  (7, 'sync_jobs', 'b0000000-0000-4000-8000-000000000008'),
  (8, 'commitments', 'b0000000-0000-4000-8000-000000000009'),
  (9, 'facts', 'b0000000-0000-4000-8000-000000000010')
) as v(ord, t, b_id)
order by v.ord;

-- A row of A's can't point at one of B's: foreign keys match on workspace_id too, because
-- foreign-key checks themselves bypass RLS (7)
select throws_ok($$insert into crm_entities (workspace_id, connection_id, kind, external_id, name)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'b0000000-0000-4000-8000-000000000002', 'contact', 'demo-2', 'Eve')$$,
  '23503', 'insert or update on table "crm_entities" violates foreign key constraint "crm_entities_connection_fk"',
  'crm_entities: A can''t attach an entity to B''s connection');
select throws_ok($$insert into session_events (id, workspace_id, session_id, seq, type, schema_version, payload, ts)
  values (gen_random_uuid(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'b0000000-0000-4000-8000-000000000004',
          7, 'session.ended', 1, '{}', now())$$,
  '23503', 'insert or update on table "session_events" violates foreign key constraint "session_events_session_fk"',
  'session_events: A can''t append an event to B''s session');
select throws_ok($$insert into utterances (workspace_id, session_id, seq, witness, text, started_ms, ended_ms)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'b0000000-0000-4000-8000-000000000004',
          7, 'biased', 'Eve was here.', 0, 900)$$,
  '23503', 'insert or update on table "utterances" violates foreign key constraint "utterances_session_fk"',
  'utterances: A can''t attach an utterance to B''s session');
select throws_ok($$insert into proposals (workspace_id, session_id, type, fields)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'b0000000-0000-4000-8000-000000000004', 'task', '{}')$$,
  '23503', 'insert or update on table "proposals" violates foreign key constraint "proposals_session_fk"',
  'proposals: A can''t attach a proposal to B''s session');
select throws_ok($$insert into proposals (workspace_id, session_id, type, target_entity_id, fields)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000004', 'task',
          'b0000000-0000-4000-8000-000000000003', '{}')$$,
  '23503', 'insert or update on table "proposals" violates foreign key constraint "proposals_target_entity_fk"',
  'proposals: A can''t target B''s entity');
select throws_ok($$insert into sync_jobs (workspace_id, proposal_id, review_id, provider,
                                           idempotency_key, not_before)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'b0000000-0000-4000-8000-000000000007',
          gen_random_uuid(), 'hubspot', repeat('e1', 32), now())$$,
  '23503', 'insert or update on table "sync_jobs" violates foreign key constraint "sync_jobs_proposal_fk"',
  'sync_jobs: A can''t queue a sync of B''s proposal');
select throws_ok($$insert into facts (workspace_id, entity_id, key, value)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'b0000000-0000-4000-8000-000000000003', 'stage', '"lost"')$$,
  '23503', 'insert or update on table "facts" violates foreign key constraint "facts_entity_fk"',
  'facts: A can''t record a fact about B''s entity');

-- Back as the owner: B's rows are all still there (1)
reset role;
select results_eq(
  $$select count(*)::int from (
      select id as ws from workspaces
      union all select workspace_id from workspace_members
      union all select workspace_id from credentials
      union all select workspace_id from crm_connections
      union all select workspace_id from crm_entities
      union all select workspace_id from sessions
      union all select workspace_id from session_events
      union all select workspace_id from utterances
      union all select workspace_id from proposals
      union all select workspace_id from sync_jobs
      union all select workspace_id from commitments
      union all select workspace_id from facts
      union all select workspace_id from audit_log
    ) r
    where ws = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  array[13],
  'as the owner afterwards: all 13 of B''s rows are still there'
);

select * from finish();
rollback;
