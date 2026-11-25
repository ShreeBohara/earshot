-- Migration 0019 (Phase 6 WP1, docs/adr/0040): sync_jobs has the outbox's columns, with `status`,
-- `adapter`, and `attempts` renamed and their checks, and the sweep's index; each proposal holds its
-- latest sync attempt and that attempt's state; each session the rep's time zone; and a checkpoint
-- may be signed for a sync. Row-level security on sync_jobs is as it was. The catalog first, as the
-- owner; then as workspace A, through row-level security, as the app writes.
begin;
select plan(47);

-- sync_jobs' columns (12)
select columns_are('public', 'sync_jobs', array[
  'id', 'workspace_id', 'proposal_id', 'review_id', 'provider', 'connection_id', 'idempotency_key',
  'attempt', 'state', 'not_before', 'mapping_version', 'error_kind', 'last_error', 'records',
  'started_at', 'finished_at', 'created_at', 'updated_at'
], 'sync_jobs has exactly the outbox''s columns: status, adapter, attempts, and external_id are gone');
select col_type_is('public', 'sync_jobs', 'review_id', 'uuid', 'sync_jobs.review_id is a uuid');
select col_not_null('public', 'sync_jobs', 'review_id', 'every job names the review it syncs');
select col_not_null('public', 'sync_jobs', 'provider', 'every job names its CRM');
select col_is_null('public', 'sync_jobs', 'connection_id', 'a job for the demo CRM has no connection');
select col_type_is('public', 'sync_jobs', 'not_before', 'timestamp with time zone',
  'sync_jobs.not_before is a timestamptz');
select col_not_null('public', 'sync_jobs', 'not_before', 'every job says when it may run');
select col_type_is('public', 'sync_jobs', 'records', 'jsonb', 'sync_jobs.records is jsonb');
select col_not_null('public', 'sync_jobs', 'records', 'sync_jobs.records is never null');
select col_type_is('public', 'sync_jobs', 'mapping_version', 'integer',
  'sync_jobs.mapping_version is an integer');
select has_index('public', 'sync_jobs', 'sync_jobs_workspace_id_state_not_before_idx',
  array['workspace_id', 'state', 'not_before'],
  'sync_jobs has the sweep''s index, on workspace, state, and when a job may run');
select col_type_is('public', 'sync_jobs', 'started_at', 'timestamp with time zone',
  'sync_jobs.started_at is a timestamptz');

-- The projections' new columns (4)
select col_type_is('public', 'proposals', 'sync', 'jsonb', 'proposals.sync is jsonb');
select col_is_null('public', 'proposals', 'sync', 'a proposal nothing has synced has no sync');
select col_type_is('public', 'proposals', 'sync_state', 'text', 'proposals.sync_state is text');
select col_type_is('public', 'sessions', 'time_zone', 'text', 'sessions.time_zone is text');

-- Row-level security on sync_jobs, as migration 0004 left it (2)
select policies_are('public', 'sync_jobs', array['tenant_isolation'],
  'sync_jobs still has exactly the tenant_isolation policy');
select table_privs_are('public', 'sync_jobs', 'earshot_app',
  array['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  'earshot_app still has exactly DELETE, INSERT, SELECT, and UPDATE on sync_jobs');

set local role earshot_app;
select set_config('app.user_id', 'user-a', true),
       set_config('app.workspace_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

-- Inside the workspace, as before (4)
select results_eq('select id::text, provider, state from sync_jobs',
  $$values ('a0000000-0000-4000-8000-000000000008', 'hubspot', 'pending')$$,
  'A sees its own job, and none of B''s');
select is_empty($$select from sync_jobs where workspace_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$,
  'B''s jobs are invisible to A, even asked for by workspace');
select throws_ok($$insert into sync_jobs (workspace_id, proposal_id, review_id, provider,
                                           idempotency_key, not_before)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b0000000-0000-4000-8000-000000000007',
          gen_random_uuid(), 'twenty', repeat('b2', 32), now())$$,
  '42501', 'new row violates row-level security policy for table "sync_jobs"',
  'A can''t queue a job in B');
select is_empty($$update sync_jobs set state = 'canceled'
  where id = 'b0000000-0000-4000-8000-000000000008' returning id$$,
  'A''s update of B''s job changes nothing');

-- A job as the outbox writes it, and a new job's defaults (2)
select lives_ok($$insert into sync_jobs (workspace_id, proposal_id, review_id, provider,
    connection_id, idempotency_key, attempt, state, not_before, mapping_version, error_kind,
    last_error, records, started_at, finished_at)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000007',
          gen_random_uuid(), 'hubspot', gen_random_uuid(), repeat('c', 64), 2, 'failed', now(), 3,
          'rate_limited', 'RATE_LIMIT', '[{"write": 0, "op": "created",
          "ref": {"object": "note", "id": "88231", "url": null}}]', now(), now())$$,
  'A can record a job with every column the outbox writes');
select results_eq($$insert into sync_jobs (workspace_id, proposal_id, review_id, provider,
                                            idempotency_key, not_before)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0000000-0000-4000-8000-000000000007',
          gen_random_uuid(), 'demo', repeat('d', 64), now())
  returning state, attempt, records::text, connection_id::text$$,
  $$values ('pending', 1, '[]', null::text)$$,
  'a new job is pending, on its first attempt, with no records, and the demo CRM''s has no connection');

-- sync_jobs' checks (12)
select lives_ok(format($$update sync_jobs set state = %L
  where id = 'a0000000-0000-4000-8000-000000000008'$$, s),
  format('sync_jobs: %s is a state', s))
from unnest(array['syncing', 'synced', 'conflicted', 'canceled']) as s;
select throws_ok($$update sync_jobs set state = 'waiting'
  where id = 'a0000000-0000-4000-8000-000000000008'$$,
  '23514', null, 'sync_jobs: a state outside the list is refused');
select throws_ok($$update sync_jobs set provider = 'salesforce'
  where id = 'a0000000-0000-4000-8000-000000000008'$$,
  '23514', null, 'sync_jobs: a CRM outside hubspot, twenty, attio, and demo is refused');
select throws_ok($$update sync_jobs set attempt = 0
  where id = 'a0000000-0000-4000-8000-000000000008'$$,
  '23514', null, 'sync_jobs: attempts are numbered from 1');
select throws_ok($$update sync_jobs set attempt = 21
  where id = 'a0000000-0000-4000-8000-000000000008'$$,
  '23514', null, 'sync_jobs: a job makes at most 20 attempts');
select throws_ok($$update sync_jobs set idempotency_key = 'a0000000-0000-4000-8000-000000000007:hubspot'
  where id = 'a0000000-0000-4000-8000-000000000008'$$,
  '23514', null, 'sync_jobs: an idempotency key is a SHA-256 in lowercase hex, nothing guessable');
select throws_ok($$update sync_jobs set mapping_version = 0
  where id = 'a0000000-0000-4000-8000-000000000008'$$,
  '23514', null, 'sync_jobs: mapping versions are numbered from 1');
select throws_ok($$update sync_jobs set error_kind = 'teapot'
  where id = 'a0000000-0000-4000-8000-000000000008'$$,
  '23514', null, 'sync_jobs: an error kind outside the taxonomy is refused');
select throws_ok($$update sync_jobs set last_error = 'Contact already exists. Existing ID: 1201'
  where id = 'a0000000-0000-4000-8000-000000000008'$$,
  '23514', null, 'sync_jobs: last_error holds a code, never a CRM''s message');

-- Each proposal's sync state (5)
select lives_ok(format($$update proposals set sync_state = %L, sync = '{}'
  where id = 'a0000000-0000-4000-8000-000000000007'$$, s),
  format('proposals: %s is a sync state', s))
from unnest(array['syncing', 'synced', 'failed', 'conflicted']) as s;
select throws_ok($$update proposals set sync_state = 'pending'
  where id = 'a0000000-0000-4000-8000-000000000007'$$,
  '23514', null, 'proposals: a sync state outside the list is refused (waiting jobs live in sync_jobs)');

-- Each session's time zone (4)
select lives_ok($$update sessions set time_zone = 'America/Argentina/Buenos_Aires'
  where id = 'a0000000-0000-4000-8000-000000000004'$$,
  'sessions: an IANA time zone fits');
select lives_ok($$update sessions set time_zone = null
  where id = 'a0000000-0000-4000-8000-000000000004'$$,
  'sessions: no time zone fits too');
select throws_ok($$update sessions set time_zone = 'UTC''; drop table sessions; --'
  where id = 'a0000000-0000-4000-8000-000000000004'$$,
  '23514', null, 'sessions: a time zone is a time zone''s name, nothing else');
select throws_ok(format($$update sessions set time_zone = %L
  where id = 'a0000000-0000-4000-8000-000000000004'$$, 'Etc/' || repeat('Z', 61)),
  '23514', null, 'sessions: a time zone is at most 64 characters');

-- A checkpoint signed for a sync (2)
select lives_ok($$insert into audit_checkpoints (workspace_id, chain_seq, entry_hash, signed_at, kid,
                                                   signature, request)
  select workspace_id, chain_seq, entry_hash, now(), 'audit-test-fixture',
         decode(repeat('0b', 64), 'hex'), 'sync'
  from audit_log where id = 'a0000000-0000-4000-8000-000000000011'$$,
  'audit_checkpoints: sync is a request a checkpoint can be signed for');
select throws_ok($$insert into audit_checkpoints (workspace_id, chain_seq, entry_hash, signed_at, kid,
                                                    signature, request)
  select workspace_id, chain_seq, entry_hash, now(), 'audit-test-fixture',
         decode(repeat('0b', 64), 'hex'), 'retry'
  from audit_log where id = 'a0000000-0000-4000-8000-000000000011'$$,
  '23514', null, 'audit_checkpoints: a request outside the list is still refused');

select * from finish();
rollback;
