-- Migration 0017 (Phase 5 WP12, docs/adr/0008): the mirror's history is append-only for the app and
-- kept inside its workspace, and a change can only name a record of its own workspace. As
-- workspace A, through row-level security, as the inbox's demo controls write; then as the owner.
begin;
select plan(14);

set local role earshot_app;
select set_config('app.user_id', 'user-a', true),
       set_config('app.workspace_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

-- Appending a change to its own record, and reading its own history (2)
select lives_ok($$insert into crm_entity_changes (workspace_id, entity_id, field, old, new, source)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000003',
          'industry', null, '"Robotics"', 'demo')$$,
  'A can record a change to its own record');
select results_eq($$select field, "new"::text from crm_entity_changes order by changed_at$$,
  $$values ('name', '"Acme"'), ('industry', '"Robotics"')$$,
  'A reads back both of its changes, and none of B''s');

-- Append-only: no update, delete, or truncate, its own changes included (4)
select throws_ok($$update crm_entity_changes set "new" = '"Acme Robotics"'
  where id = 'a0000000-0000-4000-8000-000000000014'$$,
  '42501', 'permission denied for table crm_entity_changes', 'A can''t rewrite a change');
select throws_ok($$delete from crm_entity_changes where id = 'a0000000-0000-4000-8000-000000000014'$$,
  '42501', 'permission denied for table crm_entity_changes', 'A can''t delete a change');
select throws_ok($$update crm_entity_changes set field = 'title'
  where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  '42501', 'permission denied for table crm_entity_changes', 'A can''t touch B''s history');
select throws_ok('truncate crm_entity_changes', '42501',
  'permission denied for table crm_entity_changes',
  'A can''t truncate the table (TRUNCATE would bypass RLS)');

-- Inside the workspace (3)
select throws_ok($$insert into crm_entity_changes (workspace_id, entity_id, field, old, new, source)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b0000000-0000-4000-8000-000000000003',
          'city', '"Lisbon"', '"Porto"', 'demo')$$,
  '42501', 'new row violates row-level security policy for table "crm_entity_changes"',
  'A can''t write into B''s history');
select throws_ok($$insert into crm_entity_changes (workspace_id, entity_id, field, old, new, source)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'b0000000-0000-4000-8000-000000000003',
          'city', '"Lisbon"', '"Porto"', 'demo')$$,
  '23503', 'insert or update on table "crm_entity_changes" violates foreign key constraint "crm_entity_changes_entity_fk"',
  'A can''t point a change of its own at B''s record');
select is_empty($$select from crm_entity_changes
  where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  'B''s history is invisible to A, even asked for by workspace');

-- The table's own rules (3)
select throws_ok($$insert into crm_entity_changes (workspace_id, entity_id, field, old, new, source)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000003',
          'industry', null, '"Robotics"', 'import')$$,
  '23514', null, 'a change comes from the demo CRM or a sync, nothing else');
select throws_ok($$insert into crm_entity_changes (workspace_id, entity_id, field, old, new, source)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000003',
          'Robert''); drop table crm_entities; --', null, '"x"', 'demo')$$,
  '23514', null, 'a field is a field name, nothing else');
select throws_ok($$insert into crm_entity_changes (workspace_id, entity_id, field, old, new, source)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-0000000000ff',
          'industry', null, '"Robotics"', 'demo')$$,
  '23503', null, 'a change names a record that exists');

-- As the owner (2)
reset role;
select results_eq($$select field, "new"::text from crm_entity_changes
  where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  $$values ('city', '"Lisbon"')$$,
  'as the owner: B''s history is untouched');
-- A record's history goes with it.
delete from crm_entities where id = 'a0000000-0000-4000-8000-000000000003';
select is_empty($$select from crm_entity_changes
  where workspace_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$,
  'as the owner: deleting a record deletes its history');

select * from finish();
rollback;
