-- Membership is isolated, and read-only for the app. Workspace A can't see who belongs to B, and
-- the tenant role can't change membership anywhere, its own workspace included: otherwise a
-- member could add a victim to their workspace or promote themselves. Trusted server code
-- writes membership on the owner connection. The app role can't read Better Auth's tables
-- either, so it can't list users or reach their sessions, OAuth tokens, or passkeys.
begin;
select plan(17);

set local role earshot_app;
select set_config('app.user_id', 'user-a', true),
       set_config('app.workspace_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

-- Reads are scoped to the workspace (3)
select results_eq('select workspace_id, user_id, role from workspace_members',
  $$values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'user-a', 'owner')$$,
  'A sees only its own membership');
select is_empty($$select from workspace_members where user_id = 'user-b'$$,
  'A can''t tell that user-b belongs to any workspace');
select is_empty($$select from workspace_members where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  'A can''t list B''s members');

-- Writes are denied in A's own workspace... (3)
select throws_ok($$insert into workspace_members (workspace_id, user_id, role)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-b', 'owner')$$,
  '42501', 'permission denied for table workspace_members',
  'A can''t add someone to its own workspace');
select throws_ok($$update workspace_members set role = 'owner' where user_id = 'user-a'$$,
  '42501', 'permission denied for table workspace_members',
  'A can''t change a role in its own workspace');
select throws_ok($$delete from workspace_members where user_id = 'user-a'$$,
  '42501', 'permission denied for table workspace_members',
  'A can''t remove a member from its own workspace');

-- ...and in B's (4)
select throws_ok($$insert into workspace_members (workspace_id, user_id, role)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'user-a', 'owner')$$,
  '42501', 'permission denied for table workspace_members',
  'user-a can''t make itself an owner of B');
select throws_ok($$update workspace_members set workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  where user_id = 'user-a'$$,
  '42501', 'permission denied for table workspace_members',
  'A can''t move its membership into B');
select throws_ok($$update workspace_members set user_id = 'user-a'
  where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  '42501', 'permission denied for table workspace_members',
  'A can''t take over B''s membership row');
select throws_ok($$delete from workspace_members
  where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  '42501', 'permission denied for table workspace_members',
  'A can''t remove B''s owner');

-- Better Auth's tables are closed to the app role (5)
select throws_ok(format('select from %I', t), '42501', format('permission denied for table %s', t),
  format('earshot_app can''t read Better Auth''s %s table', t))
from unnest(array['user', 'session', 'account', 'verification', 'passkey'])
  with ordinality as u(t, ord)
order by u.ord;

-- Back as the owner: both memberships are unchanged (2)
reset role;
select results_eq($$select user_id, role from workspace_members
    where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  $$values ('user-b', 'owner')$$,
  'as the owner: B''s membership is unchanged');
select results_eq($$select user_id, role from workspace_members
    where workspace_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$,
  $$values ('user-a', 'owner')$$,
  'as the owner: A still has exactly its one member');

select * from finish();
rollback;
