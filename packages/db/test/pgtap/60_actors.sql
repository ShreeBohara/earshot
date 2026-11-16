-- Actor binding: a row that names a user (sessions.user_id, audit_log.actor_user_id) must name
-- the transaction's own user, app.user_id, and that user must be a member of the row's
-- workspace. So a member can't record a session or an audit entry in someone else's name.
begin;
select plan(12);

-- As the owner: a second member of A, user-c, with a session of their own
insert into "user" (id, name, email) values ('user-c', 'Cy Cole', 'cy@a.test');
insert into workspace_members (workspace_id, user_id)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-c');
insert into sessions (id, workspace_id, user_id, mode, engine)
  values ('a0000000-0000-4000-8000-000000000104', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          'user-c', 'debrief', 'cascaded');

set local role earshot_app;
select set_config('app.user_id', 'user-a', true),
       set_config('app.workspace_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

-- Sessions (5)
select lives_ok($$insert into sessions (workspace_id, user_id, mode, engine)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-a', 'debrief', 'cascaded')$$,
  'user-a can start a session as itself');
select throws_ok($$insert into sessions (workspace_id, user_id, mode, engine)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-c', 'debrief', 'cascaded')$$,
  '42501', 'new row violates row-level security policy "actor_insert" for table "sessions"',
  'user-a can''t start a session in another member''s name');
select throws_ok($$update sessions set user_id = 'user-c'
  where id = 'a0000000-0000-4000-8000-000000000004'$$,
  '42501', 'new row violates row-level security policy "actor_update" for table "sessions"',
  'user-a can''t hand its session to another member');
select is_empty($$update sessions set engine = 'pwned'
  where id = 'a0000000-0000-4000-8000-000000000104' returning id$$,
  'user-a can''t change another member''s session');
select results_eq('select count(*)::int from sessions', array[3],
  'user-a still reads every session in its workspace: the binding limits writes only');

-- Audit entries (3)
select lives_ok($$insert into audit_log (workspace_id, actor_user_id, action)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-a', 'session.started')$$,
  'user-a can record an audit entry as itself');
select throws_ok($$insert into audit_log (workspace_id, actor_user_id, action)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-c', 'proposal.approved')$$,
  '42501', 'new row violates row-level security policy "actor_insert" for table "audit_log"',
  'user-a can''t forge an audit entry by another member');
select throws_ok($$insert into audit_log (workspace_id, actor_user_id, action)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, 'proposal.approved')$$,
  '42501', 'new row violates row-level security policy "actor_insert" for table "audit_log"',
  'user-a can''t write an anonymous audit entry either');

-- A context whose user isn't a member of its workspace, as from a caller that skipped
-- resolveWorkspace: the membership foreign keys reject it (2)
select set_config('app.user_id', 'user-b', true);
select throws_ok($$insert into sessions (workspace_id, user_id, mode, engine)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-b', 'debrief', 'cascaded')$$,
  '23503', 'insert or update on table "sessions" violates foreign key constraint "sessions_member_fk"',
  'a session for a user who isn''t a member of the workspace fails');
select throws_ok($$insert into audit_log (workspace_id, actor_user_id, action)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-b', 'proposal.approved')$$,
  '23503', 'insert or update on table "audit_log" violates foreign key constraint "audit_log_actor_fk"',
  'an audit entry by a user who isn''t a member of the workspace fails');

-- No user at all: nothing that names one can be written (2)
select set_config('app.user_id', '', true);
select throws_ok($$insert into sessions (workspace_id, user_id, mode, engine)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-a', 'debrief', 'cascaded')$$,
  '42501', 'new row violates row-level security policy "actor_insert" for table "sessions"',
  'with no app.user_id, no session can be written');
select throws_ok($$insert into audit_log (workspace_id, actor_user_id, action)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-a', 'session.started')$$,
  '42501', 'new row violates row-level security policy "actor_insert" for table "audit_log"',
  'with no app.user_id, no audit entry can be written');

select * from finish();
rollback;
