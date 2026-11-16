-- The event log is append-only for the app (docs/adr/0020, migration 0009): earshot_app can read
-- and append its own workspace's session events, but can't update, delete, or truncate any event,
-- its own included. Deleting what events belong to still deletes them, because the cascade runs
-- as the table's owner, whichever role deleted the session, member, user, or workspace.
begin;
select plan(13);

-- As the owner: two more members of A, user-d and user-e, and three more sessions in A, one each
-- for user-a, user-d, and user-e, each with one event
insert into "user" (id, name, email) values
  ('user-d', 'Di Dunn', 'di@a.test'),
  ('user-e', 'Ed Ellis', 'ed@a.test');
insert into workspace_members (workspace_id, user_id) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-d'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-e');
insert into sessions (id, workspace_id, user_id, mode, engine) values
  ('a0000000-0000-4000-8000-000000000304', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'user-a', 'debrief', 'cascaded'),
  ('a0000000-0000-4000-8000-000000000404', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'user-d', 'debrief', 'cascaded'),
  ('a0000000-0000-4000-8000-000000000504', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'user-e', 'debrief', 'cascaded');
insert into session_events (id, workspace_id, session_id, seq, type, schema_version, payload, ts)
select gen_random_uuid(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', s, 0, 'session.started', 1,
       '{}', now()
from unnest(array['a0000000-0000-4000-8000-000000000304', 'a0000000-0000-4000-8000-000000000404',
                  'a0000000-0000-4000-8000-000000000504']::uuid[]) as s;

set local role earshot_app;
select set_config('app.user_id', 'user-a', true),
       set_config('app.workspace_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

-- A can append and read (2)
select lives_ok($$insert into session_events (id, workspace_id, session_id, seq, type, schema_version, payload, ts)
  values (gen_random_uuid(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000004',
          1, 'session.ended', 1, '{}', now())$$,
  'A can append to its own session');
select results_eq($$select seq from session_events
    where session_id = 'a0000000-0000-4000-8000-000000000004' order by seq$$,
  $$values (0), (1)$$,
  'A reads its session''s events, the appended one included');

-- ...but can't change or remove any event, its own included (5)
select throws_ok($$update session_events set type = 'session.pwned'
  where id = 'a0000000-0000-4000-8000-000000000005'$$,
  '42501', 'permission denied for table session_events', 'A can''t update its own event');
select throws_ok($$update session_events set payload = '{}'$$,
  '42501', 'permission denied for table session_events', 'A can''t update events in bulk');
select throws_ok($$delete from session_events where id = 'a0000000-0000-4000-8000-000000000005'$$,
  '42501', 'permission denied for table session_events', 'A can''t delete its own event');
select throws_ok($$delete from session_events$$,
  '42501', 'permission denied for table session_events', 'A can''t delete events in bulk');
select throws_ok('truncate session_events', '42501', 'permission denied for table session_events',
  'A can''t truncate the log (TRUNCATE would bypass RLS)');

-- Deleting its own session (actor_delete allows it) still removes the session's events (2)
select lives_ok($$delete from sessions where id = 'a0000000-0000-4000-8000-000000000304'$$,
  'A can delete its own session, though it can''t delete events');
reset role;
select is_empty($$select from session_events
    where session_id = 'a0000000-0000-4000-8000-000000000304'$$,
  'as the owner: the session''s events went with it');

-- As the owner: removing a member, deleting a user, and deleting a workspace remove the events
-- under them too (3)
delete from workspace_members where user_id = 'user-d';
select is_empty($$select from session_events
    where session_id = 'a0000000-0000-4000-8000-000000000404'$$,
  'removing a member removes the events of their sessions');
delete from "user" where id = 'user-e';
select is_empty($$select from session_events
    where session_id = 'a0000000-0000-4000-8000-000000000504'$$,
  'deleting a user removes the events of their sessions');
delete from workspaces where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select is_empty($$select from session_events
    where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  'deleting a workspace removes its events');

-- ...and A's seeded event is as it was (1)
select results_eq($$select type, schema_version from session_events
    where id = 'a0000000-0000-4000-8000-000000000005'$$,
  $$values ('utterance.final', 1)$$,
  'as the owner: A''s seeded event is unchanged');

select * from finish();
rollback;
