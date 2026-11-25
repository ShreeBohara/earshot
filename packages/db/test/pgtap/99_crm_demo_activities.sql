-- Migration 0020 (Phase 6 WP2, docs/adr/0041): the demo CRM's notes, tasks, and meetings are
-- append-only for the app and kept inside their workspace, an activity can only sit on a record of
-- its own workspace, and the table's checks hold. As workspace A, through row-level security, as the
-- demo adapter's store writes; then as the owner.
begin;
select plan(20);

set local role earshot_app;
select set_config('app.user_id', 'user-a', true),
       set_config('app.workspace_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

-- Appending an activity to its own record, and reading its own (2)
select lives_ok($$insert into crm_demo_activities (workspace_id, kind, entity_id, write_id, body, due_at)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'task', 'a0000000-0000-4000-8000-000000000003',
          'es_cccccccccccccccccccc', 'Send the deck', '2026-12-04T15:00:00Z')$$,
  'A can add a task to its own record');
select results_eq($$select kind, write_id from crm_demo_activities order by created_at$$,
  $$values ('note', 'es_aaaaaaaaaaaaaaaaaaaa'), ('task', 'es_cccccccccccccccccccc')$$,
  'A reads back both of its activities, and none of B''s');

-- Append-only: no update, delete, or truncate, its own activities included (4)
select throws_ok($$update crm_demo_activities set body = 'Rewritten'
  where id = 'a0000000-0000-4000-8000-000000000015'$$,
  '42501', 'permission denied for table crm_demo_activities', 'A can''t rewrite an activity');
select throws_ok($$delete from crm_demo_activities where id = 'a0000000-0000-4000-8000-000000000015'$$,
  '42501', 'permission denied for table crm_demo_activities', 'A can''t delete an activity');
select throws_ok($$update crm_demo_activities set kind = 'task'
  where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  '42501', 'permission denied for table crm_demo_activities', 'A can''t touch B''s activities');
select throws_ok('truncate crm_demo_activities', '42501',
  'permission denied for table crm_demo_activities',
  'A can''t truncate the table (TRUNCATE would bypass RLS)');

-- Inside the workspace (3)
select throws_ok($$insert into crm_demo_activities (workspace_id, kind, entity_id, write_id, body)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'note', 'b0000000-0000-4000-8000-000000000003',
          'es_dddddddddddddddddddd', 'Hijack')$$,
  '42501', 'new row violates row-level security policy for table "crm_demo_activities"',
  'A can''t write into B''s activities');
select throws_ok($$insert into crm_demo_activities (workspace_id, kind, entity_id, write_id, body)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'note', 'b0000000-0000-4000-8000-000000000003',
          'es_dddddddddddddddddddd', 'On B''s record')$$,
  '23503', 'insert or update on table "crm_demo_activities" violates foreign key constraint "crm_demo_activities_entity_fk"',
  'A can''t put an activity of its own on B''s record');
select is_empty($$select from crm_demo_activities
  where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  'B''s activities are invisible to A, even asked for by workspace');

-- The table's own rules (8)
select throws_ok($$insert into crm_demo_activities (workspace_id, kind, entity_id, write_id, body)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'email', 'a0000000-0000-4000-8000-000000000003',
          'es_eeeeeeeeeeeeeeeeeeee', 'x')$$,
  '23514', null, 'an activity is a note, a task, or a meeting, nothing else');
select throws_ok($$insert into crm_demo_activities (workspace_id, kind, entity_id, write_id, body)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'note', 'a0000000-0000-4000-8000-000000000003',
          'Robert''); drop table crm_entities; --', 'x')$$,
  '23514', null, 'a write id is a marker, nothing else');
select throws_ok($$insert into crm_demo_activities (workspace_id, kind, entity_id, write_id, body)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'note', 'a0000000-0000-4000-8000-000000000003',
          'es_eeeeeeeeeeeeeeeeeeee', '')$$,
  '23514', null, 'a body says something');
select throws_ok($$insert into crm_demo_activities (workspace_id, kind, entity_id, write_id, body)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'note', 'a0000000-0000-4000-8000-000000000003',
          'es_eeeeeeeeeeeeeeeeeeee', repeat('x', 20001))$$,
  '23514', null, 'a body holds at most 20,000 characters');
select throws_ok($$insert into crm_demo_activities (workspace_id, kind, entity_id, write_id, body, due_at)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'note', 'a0000000-0000-4000-8000-000000000003',
          'es_eeeeeeeeeeeeeeeeeeee', 'x', '2026-12-04T15:00:00Z')$$,
  '23514', null, 'only a task has a due time');
select throws_ok($$insert into crm_demo_activities (workspace_id, kind, entity_id, write_id, body, starts_at)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'task', 'a0000000-0000-4000-8000-000000000003',
          'es_eeeeeeeeeeeeeeeeeeee', 'x', '2026-12-03T20:30:00Z')$$,
  '23514', null, 'only a meeting has a start');
select throws_ok($$insert into crm_demo_activities (workspace_id, kind, entity_id, write_id, body)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'meeting', 'a0000000-0000-4000-8000-000000000003',
          'es_aaaaaaaaaaaaaaaaaaaa', 'A second try')$$,
  '23505', null, 'a write id lands once in its workspace');
select throws_ok($$insert into crm_demo_activities (workspace_id, kind, entity_id, write_id, body)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'note', 'a0000000-0000-4000-8000-0000000000ff',
          'es_eeeeeeeeeeeeeeeeeeee', 'x')$$,
  '23503', null, 'an activity sits on a record that exists');

-- As the owner (3)
reset role;
select results_eq($$select write_id from crm_demo_activities
  where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  $$values ('es_bbbbbbbbbbbbbbbbbbbb')$$,
  'as the owner: B''s activities are untouched');
select lives_ok($$insert into crm_demo_activities (workspace_id, kind, entity_id, write_id, body)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'note', 'b0000000-0000-4000-8000-000000000003',
          'es_aaaaaaaaaaaaaaaaaaaa', 'Unique per workspace, not across them')$$,
  'as the owner: another workspace may hold the same write id');
-- An activity goes with its record.
delete from crm_entities where id = 'a0000000-0000-4000-8000-000000000003';
select is_empty($$select from crm_demo_activities
  where workspace_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$,
  'as the owner: deleting a record deletes its activities');

select * from finish();
rollback;
