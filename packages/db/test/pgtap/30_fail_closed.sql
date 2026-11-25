-- Failing closed: as earshot_app with no workspace set, every tenant table looks empty and
-- nothing can be written. The harness runs each file in a fresh session, so app.workspace_id
-- starts out never set.
begin;
select plan(22);

set local role earshot_app;

select is(current_setting('app.workspace_id', true), null,
  'app.workspace_id has never been set in this session');

-- Never set: no rows anywhere (16)
select is_empty(format('select from %I', t), format('%s: no rows without a workspace', t))
from unnest(array[
  'workspaces', 'workspace_members', 'credentials', 'crm_connections', 'crm_entities', 'sessions',
  'session_events', 'utterances', 'proposals', 'sync_jobs', 'commitments', 'facts', 'audit_log',
  'audit_checkpoints', 'approval_policies', 'crm_entity_changes'
]) with ordinality as u(t, ord)
order by u.ord;

-- ...and no writes, even with a real workspace's id (2)
select throws_ok($$insert into commitments (workspace_id, owner, text)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'rep', 'Send pricing')$$,
  '42501', 'new row violates row-level security policy for table "commitments"',
  'commitments: no insert without a workspace');
select is_empty($$update credentials set label = 'pwned' returning id$$,
  'credentials: an update without a workspace matches nothing');

-- Empty: what a session's setting reverts to after a transaction that set it (1)
select set_config('app.workspace_id', '', true);
select is_empty(
  $$select id from workspaces
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
    union all select workspace_id from audit_checkpoints
    union all select workspace_id from approval_policies
    union all select workspace_id from crm_entity_changes$$,
  'an empty app.workspace_id shows no rows in any tenant table'
);

-- Malformed: the uuid cast in the policy errors instead of matching anything (1)
select set_config('app.workspace_id', 'not-a-uuid', true);
select throws_ok('select from credentials', '22P02', 'invalid input syntax for type uuid: "not-a-uuid"',
  'a malformed app.workspace_id is an error, not a match');

-- The owner isn't subject to RLS: migrations and seeds see everything (1)
reset role;
select results_eq('select count(*)::int from credentials', array[2],
  'the owner sees every workspace''s rows');

select * from finish();
rollback;
