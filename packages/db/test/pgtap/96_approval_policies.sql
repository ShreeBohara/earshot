-- Migration 0016 (Phase 5 WP11, docs/adr/0034): approval policies are append-only for the app, kept
-- inside their workspace, and written only in the transaction's own user's name. As workspace A,
-- through row-level security, as the web Worker's policy route writes; then as the owner.
begin;
select plan(17);

-- As the owner: a second member of A, user-c (2 of the checks below use them).
insert into "user" (id, name, email) values ('user-c', 'Cy Cole', 'cy@a.test');
insert into workspace_members (workspace_id, user_id)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-c');

set local role earshot_app;
select set_config('app.user_id', 'user-a', true),
       set_config('app.workspace_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

-- Appending a version, and reading the workspace's own (2)
select lives_ok($$insert into approval_policies (workspace_id, id, version, rules, rules_sha256, created_by)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000013', 2,
          '{"v": 1, "autoApprove": []}', repeat('0', 64), 'user-a')$$,
  'A can append the next version of its policy, in its own name');
select results_eq('select version, created_by from approval_policies order by version',
  $$values (1, 'user-a'), (2, 'user-a')$$,
  'A reads back both of its versions, and none of B''s');

-- Append-only: no update, delete, or truncate, its own versions included (4)
select throws_ok($$update approval_policies set rules = '{"v": 1, "autoApprove": []}'
  where workspace_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and version = 1$$,
  '42501', 'permission denied for table approval_policies', 'A can''t rewrite a version');
select throws_ok($$delete from approval_policies where version = 1$$,
  '42501', 'permission denied for table approval_policies', 'A can''t delete a version');
select throws_ok($$update approval_policies set version = 9
  where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  '42501', 'permission denied for table approval_policies', 'A can''t touch B''s versions');
select throws_ok('truncate approval_policies', '42501',
  'permission denied for table approval_policies',
  'A can''t truncate the table (TRUNCATE would bypass RLS)');

-- Inside the workspace, in the user's own name (4)
select throws_ok($$insert into approval_policies (workspace_id, id, version, rules, rules_sha256, created_by)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b0000000-0000-4000-8000-000000000013', 2,
          '{"v": 1, "autoApprove": []}', repeat('0', 64), 'user-a')$$,
  '42501', 'new row violates row-level security policy for table "approval_policies"',
  'A can''t write a version of B''s policy');
select throws_ok($$insert into approval_policies (workspace_id, id, version, rules, rules_sha256, created_by)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000013', 3,
          '{"v": 1, "autoApprove": []}', repeat('0', 64), 'user-c')$$,
  '42501', 'new row violates row-level security policy "actor_insert" for table "approval_policies"',
  'user-a can''t change the policy in another member''s name');
select throws_ok($$insert into approval_policies (workspace_id, id, version, rules, rules_sha256, created_by)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000013', 3,
          '{"v": 1, "autoApprove": []}', repeat('0', 64), null)$$,
  '42501', 'new row violates row-level security policy "actor_insert" for table "approval_policies"',
  'nor with no author at all');
select is_empty($$select from approval_policies
  where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  'B''s versions are invisible to A, even asked for by workspace');

-- The table's own rules (3)
select throws_ok($$insert into approval_policies (workspace_id, id, version, rules, rules_sha256, created_by)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000013', 2,
          '{"v": 1, "autoApprove": []}', repeat('0', 64), 'user-a')$$,
  '23505', null, 'a version number is used once per workspace');
select throws_ok($$insert into approval_policies (workspace_id, id, version, rules, rules_sha256, created_by)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000013', 0,
          '{"v": 1, "autoApprove": []}', repeat('0', 64), 'user-a')$$,
  '23514', null, 'versions start at 1');
select throws_ok($$insert into approval_policies (workspace_id, id, version, rules, rules_sha256, created_by)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000013', 3,
          '{"v": 1, "autoApprove": []}', repeat('A', 64), 'user-a')$$,
  '23514', null, 'the rules'' hash is 64 lowercase hex digits');

-- A user who isn't a member of the workspace can't be its author, whatever app.user_id says (1)
select set_config('app.user_id', 'user-b', true);
select throws_ok($$insert into approval_policies (workspace_id, id, version, rules, rules_sha256, created_by)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000013', 3,
          '{"v": 1, "autoApprove": []}', repeat('0', 64), 'user-b')$$,
  '23503', 'insert or update on table "approval_policies" violates foreign key constraint "approval_policies_creator_fk"',
  'a version by a user who isn''t a member of the workspace fails');

-- As the owner (3)
reset role;
select results_eq($$select workspace_id::text, version, rules_sha256 from approval_policies
  where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  $$values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            1, '29691d66e9547d778f4961ea341e651ba49adf772c057ad20ee6b2942ee9f60e')$$,
  'as the owner: B''s policy is untouched');
-- When its author leaves the workspace, a version stays and only its author is cleared.
delete from workspace_members
  where workspace_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and user_id = 'user-a';
select results_eq($$select version, created_by from approval_policies
  where workspace_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' order by version$$,
  $$values (1, null::text), (2, null::text)$$,
  'as the owner: a departed author''s versions stay, unattributed');
select results_eq($$select count(*)::int from approval_policies$$, array[3],
  'as the owner: three versions, nothing deleted');

select * from finish();
rollback;
