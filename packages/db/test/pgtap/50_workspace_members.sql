-- Membership is isolated too: workspace A can't see who belongs to B, join B, or change B's
-- members. And the app role can't read Better Auth's tables at all, so it can't list users
-- or reach their sessions, OAuth tokens, or passkeys.
begin;
select plan(14);

set local role earshot_app;
select set_config('app.user_id', 'user-a', true),
       set_config('app.workspace_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

select results_eq('select workspace_id, user_id, role from workspace_members',
  $$values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'user-a', 'owner')$$,
  'A sees only its own membership');
select is_empty($$select from workspace_members where user_id = 'user-b'$$,
  'A can''t tell that user-b belongs to any workspace');
select is_empty($$select from workspace_members where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  'A can''t list B''s members');

select throws_ok($$insert into workspace_members (workspace_id, user_id, role)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'user-a', 'owner')$$,
  '42501', 'new row violates row-level security policy for table "workspace_members"',
  'user-a can''t make itself an owner of B');
select throws_ok($$update workspace_members set workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  where user_id = 'user-a'$$,
  '42501', 'new row violates row-level security policy for table "workspace_members"',
  'A can''t move its membership into B');
select is_empty($$update workspace_members set user_id = 'user-a'
  where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' returning user_id$$,
  'A can''t take over B''s membership row');
select is_empty($$delete from workspace_members
  where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' returning user_id$$,
  'A can''t remove B''s owner');

-- Better Auth's tables are closed to the app role (5)
select throws_ok(format('select from %I', t), '42501', format('permission denied for table %s', t),
  format('earshot_app can''t read Better Auth''s %s table', t))
from unnest(array['user', 'session', 'account', 'verification', 'passkey'])
  with ordinality as u(t, ord)
order by u.ord;

-- Back as the owner: B's membership is unchanged, and A's is still a single row (2)
reset role;
select results_eq($$select user_id, role from workspace_members
    where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  $$values ('user-b', 'owner')$$,
  'as the owner: B''s membership is unchanged');
select results_eq($$select user_id from workspace_members
    where workspace_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$,
  $$values ('user-a')$$,
  'as the owner: A still has exactly its one member');

select * from finish();
rollback;
