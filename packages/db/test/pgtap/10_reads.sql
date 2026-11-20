-- Reads: as earshot_app, each workspace sees only its own rows, and the other workspace's ids
-- return nothing. Ids come from test/fixtures/two-workspaces.sql.
begin;
select plan(56);

-- As the owner, which RLS doesn't apply to: both workspaces have a row everywhere (14)
select results_eq(format('select count(*)::int from %I', t), array[2], format('%s: the owner sees both workspaces'' rows', t))
from unnest(array[
  'workspaces', 'workspace_members', 'credentials', 'crm_connections', 'crm_entities', 'sessions',
  'session_events', 'utterances', 'proposals', 'sync_jobs', 'commitments', 'facts', 'audit_log',
  'audit_checkpoints'
]) with ordinality as u(t, ord)
order by u.ord;

-- As workspace A (28)
set local role earshot_app;
select set_config('app.user_id', 'user-a', true),
       set_config('app.workspace_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

select results_eq('select id from workspaces',
  $$values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid)$$, 'workspaces: A sees only itself');
select is_empty($$select from workspaces where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  'workspaces: B''s id returns nothing');

select results_eq('select workspace_id, user_id from workspace_members',
  $$values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'user-a')$$,
  'workspace_members: A sees only its own member');
select is_empty($$select from workspace_members where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  'workspace_members: B''s workspace id returns nothing');

select results_eq('select id from credentials',
  $$values ('a0000000-0000-4000-8000-000000000001'::uuid)$$, 'credentials: A sees only its own row');
select is_empty($$select from credentials where id = 'b0000000-0000-4000-8000-000000000001'$$,
  'credentials: B''s id returns nothing');

select results_eq('select id from crm_connections',
  $$values ('a0000000-0000-4000-8000-000000000002'::uuid)$$, 'crm_connections: A sees only its own row');
select is_empty($$select from crm_connections where id = 'b0000000-0000-4000-8000-000000000002'$$,
  'crm_connections: B''s id returns nothing');

select results_eq('select id from crm_entities',
  $$values ('a0000000-0000-4000-8000-000000000003'::uuid)$$, 'crm_entities: A sees only its own row');
select is_empty($$select from crm_entities where id = 'b0000000-0000-4000-8000-000000000003'$$,
  'crm_entities: B''s id returns nothing');

select results_eq('select id from sessions',
  $$values ('a0000000-0000-4000-8000-000000000004'::uuid)$$, 'sessions: A sees only its own row');
select is_empty($$select from sessions where id = 'b0000000-0000-4000-8000-000000000004'$$,
  'sessions: B''s id returns nothing');

select results_eq('select id from session_events',
  $$values ('a0000000-0000-4000-8000-000000000005'::uuid)$$, 'session_events: A sees only its own row');
select is_empty($$select from session_events where session_id = 'b0000000-0000-4000-8000-000000000004'$$,
  'session_events: B''s session id returns nothing');

select results_eq('select id from utterances',
  $$values ('a0000000-0000-4000-8000-000000000006'::uuid)$$, 'utterances: A sees only its own row');
select is_empty($$select from utterances where id = 'b0000000-0000-4000-8000-000000000006'$$,
  'utterances: B''s id returns nothing');

select results_eq('select id from proposals',
  $$values ('a0000000-0000-4000-8000-000000000007'::uuid)$$, 'proposals: A sees only its own row');
select is_empty($$select from proposals where id = 'b0000000-0000-4000-8000-000000000007'$$,
  'proposals: B''s id returns nothing');

select results_eq('select id from sync_jobs',
  $$values ('a0000000-0000-4000-8000-000000000008'::uuid)$$, 'sync_jobs: A sees only its own row');
select is_empty($$select from sync_jobs where id = 'b0000000-0000-4000-8000-000000000008'$$,
  'sync_jobs: B''s id returns nothing');

select results_eq('select id from commitments',
  $$values ('a0000000-0000-4000-8000-000000000009'::uuid)$$, 'commitments: A sees only its own row');
select is_empty($$select from commitments where id = 'b0000000-0000-4000-8000-000000000009'$$,
  'commitments: B''s id returns nothing');

select results_eq('select id from facts',
  $$values ('a0000000-0000-4000-8000-000000000010'::uuid)$$, 'facts: A sees only its own row');
select is_empty($$select from facts where id = 'b0000000-0000-4000-8000-000000000010'$$,
  'facts: B''s id returns nothing');

select results_eq('select id from audit_log',
  $$values ('a0000000-0000-4000-8000-000000000011'::uuid)$$, 'audit_log: A sees only its own row');
select is_empty($$select from audit_log where id = 'b0000000-0000-4000-8000-000000000011'$$,
  'audit_log: B''s id returns nothing');

select results_eq('select id from audit_checkpoints',
  $$values ('a0000000-0000-4000-8000-000000000012'::uuid)$$, 'audit_checkpoints: A sees only its own row');
select is_empty($$select from audit_checkpoints where id = 'b0000000-0000-4000-8000-000000000012'$$,
  'audit_checkpoints: B''s id returns nothing');

-- As workspace B, in the same transaction and role: the policy follows the setting (14)
select set_config('app.user_id', 'user-b', true),
       set_config('app.workspace_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);

select results_eq('select id from workspaces',
  $$values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid)$$, 'workspaces: B sees only itself');
select results_eq(format('select workspace_id from %I', t),
  $$values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid)$$, format('%s: B sees only its own row', t))
from unnest(array[
  'workspace_members', 'credentials', 'crm_connections', 'crm_entities', 'sessions',
  'session_events', 'utterances', 'proposals', 'sync_jobs', 'commitments', 'facts', 'audit_log',
  'audit_checkpoints'
]) with ordinality as u(t, ord)
order by u.ord;

select * from finish();
rollback;
