-- Structure: the role, policies, and grants that tenant isolation rests on (docs/adr/0019).
-- Runs as the owner and changes no data. The catalog checks fail when someone adds a table
-- with a workspace_id column but no RLS, or grants the app a table that RLS doesn't protect.
begin;
select plan(81);

create temp table tenant_tables (name text primary key, key text not null, ord int not null);
insert into tenant_tables (name, key, ord) values
  ('workspaces', 'id', 1),
  ('workspace_members', 'workspace_id', 2),
  ('credentials', 'workspace_id', 3),
  ('crm_connections', 'workspace_id', 4),
  ('crm_entities', 'workspace_id', 5),
  ('sessions', 'workspace_id', 6),
  ('session_events', 'workspace_id', 7),
  ('utterances', 'workspace_id', 8),
  ('proposals', 'workspace_id', 9),
  ('sync_jobs', 'workspace_id', 10),
  ('commitments', 'workspace_id', 11),
  ('facts', 'workspace_id', 12),
  ('audit_log', 'workspace_id', 13);

-- The role (4)
select has_role('earshot_app', 'role earshot_app exists');
select ok(not rolcanlogin, 'earshot_app cannot log in')
from pg_roles where rolname = 'earshot_app';
select ok(not rolsuper and not rolbypassrls, 'earshot_app is no superuser and does not bypass RLS')
from pg_roles where rolname = 'earshot_app';
select ok(
  exists (
    select from pg_auth_members m
    where m.roleid = 'earshot_app'::regrole
      and m.member = (select oid from pg_roles where rolname = current_user)
      and m.set_option
  ),
  'the owner may SET ROLE earshot_app'
);

-- Every tenant table has RLS enabled (13)
select ok(c.relrowsecurity, format('%s has row-level security enabled', t.name))
from tenant_tables t
join pg_class c on c.oid = format('public.%I', t.name)::regclass
order by t.ord;

-- ...with exactly one policy (13)...
select policies_are(
  'public', t.name::name, array['tenant_isolation']::name[],
  format('%s has exactly one policy, tenant_isolation', t.name)
)
from tenant_tables t order by t.ord;

-- ...that applies to earshot_app (13)...
select policy_roles_are(
  'public', t.name::name, 'tenant_isolation', array['earshot_app']::name[],
  format('%s: tenant_isolation applies to earshot_app', t.name)
)
from tenant_tables t order by t.ord;

-- ...covers every command, and checks the workspace in both USING and WITH CHECK (13)
select is(
  row(p.cmd, p.permissive, p.qual, p.with_check)::text,
  row('ALL', 'PERMISSIVE', e.expr, e.expr)::text,
  format('%s: tenant_isolation is FOR ALL, with the fail-closed check in USING and WITH CHECK', t.name)
)
from tenant_tables t
join pg_policies p
  on p.schemaname = 'public' and p.tablename = t.name and p.policyname = 'tenant_isolation'
cross join lateral (
  select format(
    '(%s = (NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))::uuid)',
    t.key
  ) as expr
) e
order by t.ord;

-- Catalog-wide invariants (5)
select set_eq(
  $$select relname::text from pg_class
    where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and relrowsecurity$$,
  $$select name from tenant_tables$$,
  'row-level security is on for exactly the tenant tables'
);
select set_eq(
  $$select c.relname::text from pg_class c
    join pg_attribute a on a.attrelid = c.oid
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
      and a.attname = 'workspace_id' and not a.attisdropped$$,
  $$select name from tenant_tables where key = 'workspace_id'$$,
  'every table with a workspace_id column is a tenant table'
);
select is_empty(
  $$select c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and not c.relrowsecurity
      and has_table_privilege(
        'earshot_app', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
      )
      -- Skip extensions' own catalog views, such as pgTAP's here.
      and not exists (
        select from pg_depend d
        where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
      )$$,
  'earshot_app has no privileges on any table or view without row-level security'
);
select is_empty(
  $$select relname from pg_class where relowner = 'earshot_app'::regrole$$,
  'earshot_app owns nothing (owners bypass RLS)'
);
select is_empty(
  $$select c.conname::text
    from pg_constraint c
    where c.contype = 'f'
      and c.connamespace = 'public'::regnamespace
      and c.confrelid <> 'public.workspaces'::regclass
      and exists (
        select from pg_attribute a
        where a.attrelid = c.confrelid and a.attname = 'workspace_id' and not a.attisdropped
      )
      and not exists (
        select from unnest(c.conkey, c.confkey) as k(src, dst)
        join pg_attribute s on s.attrelid = c.conrelid and s.attnum = k.src
        join pg_attribute d on d.attrelid = c.confrelid and d.attnum = k.dst
        where s.attname = 'workspace_id' and d.attname = 'workspace_id'
      )$$,
  'every foreign key into a tenant table matches on workspace_id, so no row can point across workspaces'
);

-- Grants: the app may read and write tenant tables, only append to audit_log (13)...
select table_privs_are(
  'public', t.name::name, 'earshot_app',
  case when t.name = 'audit_log'
    then array['INSERT', 'SELECT']::name[]
    else array['DELETE', 'INSERT', 'SELECT', 'UPDATE']::name[]
  end,
  case when t.name = 'audit_log'
    then 'earshot_app may only read and append to audit_log'
    else format('earshot_app may select, insert, update, and delete in %s, and nothing more', t.name)
  end
)
from tenant_tables t order by t.ord;

-- ...and has no privileges at all on Better Auth's tables or app_meta (6)...
select table_privs_are(
  'public', u.t::name, 'earshot_app', '{}'::name[],
  format('earshot_app has no privileges on %s', u.t)
)
from unnest(array['user', 'session', 'account', 'verification', 'passkey', 'app_meta'])
  with ordinality as u(t, ord)
order by u.ord;

-- ...and can't create objects (1)
select schema_privs_are(
  'public', 'earshot_app', array['USAGE']::name[],
  'earshot_app can use schema public but not create objects in it'
);

select * from finish();
rollback;
