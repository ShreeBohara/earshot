-- The audit log is append-only for the app: earshot_app can read and insert its own workspace's
-- entries, but can't update, delete, or truncate any entry, its own included.
begin;
select plan(9);

set local role earshot_app;
select set_config('app.user_id', 'user-a', true),
       set_config('app.workspace_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

select lives_ok($$insert into audit_log (workspace_id, actor_user_id, action, subject_type, subject_id)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-a', 'proposal.edited', 'proposal',
          'a0000000-0000-4000-8000-000000000007')$$,
  'A can append to its audit log');
select results_eq('select action from audit_log order by action',
  $$values ('proposal.approved'), ('proposal.edited')$$,
  'A reads back its own two entries');

select throws_ok($$update audit_log set action = 'proposal.rejected'
  where id = 'a0000000-0000-4000-8000-000000000011'$$,
  '42501', 'permission denied for table audit_log', 'A can''t update its own entry');
select throws_ok($$delete from audit_log where id = 'a0000000-0000-4000-8000-000000000011'$$,
  '42501', 'permission denied for table audit_log', 'A can''t delete its own entry');
select throws_ok($$update audit_log set action = 'proposal.rejected'
  where id = 'b0000000-0000-4000-8000-000000000011'$$,
  '42501', 'permission denied for table audit_log', 'A can''t update B''s entry');
select throws_ok($$delete from audit_log where id = 'b0000000-0000-4000-8000-000000000011'$$,
  '42501', 'permission denied for table audit_log', 'A can''t delete B''s entry');
select throws_ok('truncate audit_log', '42501', 'permission denied for table audit_log',
  'A can''t truncate the audit log (TRUNCATE would bypass RLS)');

-- As the owner: both seeded entries are untouched (2)
reset role;
select results_eq($$select id, action from audit_log where action = 'proposal.approved' order by id$$,
  $$values ('a0000000-0000-4000-8000-000000000011'::uuid, 'proposal.approved'),
           ('b0000000-0000-4000-8000-000000000011'::uuid, 'proposal.approved')$$,
  'as the owner: both seeded entries are unchanged');
select results_eq('select count(*)::int from audit_log', array[3],
  'as the owner: three entries, nothing deleted');

select * from finish();
rollback;
