-- Better Auth's rate-limit counters (migration 0011) belong to the owner, like its other tables:
-- not a tenant table, so no row-level security, and the tenant role can neither read nor write
-- them. A member who could reset the counters could lift the limit on sign-in attempts.
begin;
select plan(6);

select has_table('public', 'rate_limit', 'rate_limit exists');
select ok(not c.relrowsecurity, 'rate_limit has no row-level security: it is not a tenant table')
from pg_class c where c.oid = 'public.rate_limit'::regclass;
select table_privs_are('public', 'rate_limit', 'earshot_app', '{}'::name[],
  'earshot_app has no privileges on rate_limit');
select col_is_unique('public', 'rate_limit', 'key', 'one counter per client and path');
select col_type_is('public', 'rate_limit', 'last_request', 'bigint',
  'last_request holds Unix milliseconds');

set local role earshot_app;
select throws_ok('select count(*) from rate_limit', '42501', null,
  'as earshot_app: reading rate_limit is denied');

select * from finish();
rollback;
