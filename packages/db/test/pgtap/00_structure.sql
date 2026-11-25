-- Structure: the role, policies, and grants that tenant isolation rests on (docs/adr/0019).
-- Runs as the owner and changes no data. The catalog checks fail when someone adds a table
-- with a workspace_id column but no RLS, grants the app a table that RLS doesn't protect, or
-- lets the app write a user column that isn't bound to app.user_id.
begin;
select plan(106);

create temp table tenant_tables (
  name text primary key,
  key text not null,
  privs name[] not null,
  policies name[] not null,
  ord int not null
);
insert into tenant_tables (name, key, privs, policies, ord) values
  ('workspaces', 'id', '{SELECT}', '{tenant_isolation}', 1),
  ('workspace_members', 'workspace_id', '{SELECT}', '{tenant_isolation}', 2),
  ('credentials', 'workspace_id', '{DELETE,INSERT,SELECT,UPDATE}', '{tenant_isolation}', 3),
  ('crm_connections', 'workspace_id', '{DELETE,INSERT,SELECT,UPDATE}', '{tenant_isolation}', 4),
  ('crm_entities', 'workspace_id', '{DELETE,INSERT,SELECT,UPDATE}', '{tenant_isolation}', 5),
  ('sessions', 'workspace_id', '{DELETE,INSERT,SELECT,UPDATE}',
   '{tenant_isolation,actor_insert,actor_update,actor_delete}', 6),
  ('session_events', 'workspace_id', '{INSERT,SELECT}', '{tenant_isolation}', 7),
  ('utterances', 'workspace_id', '{DELETE,INSERT,SELECT,UPDATE}', '{tenant_isolation}', 8),
  ('proposals', 'workspace_id', '{DELETE,INSERT,SELECT,UPDATE}', '{tenant_isolation}', 9),
  ('sync_jobs', 'workspace_id', '{DELETE,INSERT,SELECT,UPDATE}', '{tenant_isolation}', 10),
  ('commitments', 'workspace_id', '{DELETE,INSERT,SELECT,UPDATE}', '{tenant_isolation}', 11),
  ('facts', 'workspace_id', '{DELETE,INSERT,SELECT,UPDATE}', '{tenant_isolation}', 12),
  ('audit_log', 'workspace_id', '{INSERT,SELECT}', '{tenant_isolation,actor_insert}', 13),
  ('audit_checkpoints', 'workspace_id', '{INSERT,SELECT}', '{tenant_isolation}', 14),
  ('approval_policies', 'workspace_id', '{INSERT,SELECT}', '{tenant_isolation,actor_insert}', 15),
  ('crm_entity_changes', 'workspace_id', '{INSERT,SELECT}', '{tenant_isolation}', 16);

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

-- Every tenant table has RLS enabled (16)
select ok(c.relrowsecurity, format('%s has row-level security enabled', t.name))
from tenant_tables t
join pg_class c on c.oid = format('public.%I', t.name)::regclass
order by t.ord;

-- ...with exactly the expected policies (16)...
select policies_are(
  'public', t.name::name, t.policies,
  format('%s has exactly the policies %s', t.name, array_to_string(t.policies, ', '))
)
from tenant_tables t order by t.ord;

-- ...including tenant_isolation for earshot_app (16)...
select policy_roles_are(
  'public', t.name::name, 'tenant_isolation', array['earshot_app']::name[],
  format('%s: tenant_isolation applies to earshot_app', t.name)
)
from tenant_tables t order by t.ord;

-- ...which covers every command and checks the workspace in USING and WITH CHECK (16)
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

-- The actor policies: restrictive, for earshot_app, and fail-closed on app.user_id (5). A
-- missing policy emits no row, which the plan count catches.
select is(
  row(p.cmd, p.permissive, p.roles::text, p.qual, p.with_check)::text,
  row(e.cmd, 'RESTRICTIVE', '{earshot_app}', e.qual, e.with_check)::text,
  e.description
)
from (values
  (1, 'sessions', 'actor_insert', 'INSERT', null,
   '(user_id = NULLIF(current_setting(''app.user_id''::text, true), ''''::text))',
   'sessions: actor_insert binds user_id to app.user_id on insert'),
  (2, 'sessions', 'actor_update', 'UPDATE',
   '(user_id = NULLIF(current_setting(''app.user_id''::text, true), ''''::text))',
   '(user_id = NULLIF(current_setting(''app.user_id''::text, true), ''''::text))',
   'sessions: actor_update limits updates to the user''s own sessions, and keeps them theirs'),
  (3, 'sessions', 'actor_delete', 'DELETE',
   '(user_id = NULLIF(current_setting(''app.user_id''::text, true), ''''::text))', null,
   'sessions: actor_delete limits deletes to the user''s own sessions'),
  (4, 'audit_log', 'actor_insert', 'INSERT', null,
   '(actor_user_id = NULLIF(current_setting(''app.user_id''::text, true), ''''::text))',
   'audit_log: actor_insert binds actor_user_id to app.user_id on insert'),
  (5, 'approval_policies', 'actor_insert', 'INSERT', null,
   '(created_by = NULLIF(current_setting(''app.user_id''::text, true), ''''::text))',
   'approval_policies: actor_insert binds created_by to app.user_id on insert')
) as e(ord, tablename, policyname, cmd, qual, with_check, description)
join pg_policies p
  on p.schemaname = 'public' and p.tablename = e.tablename and p.policyname = e.policyname
order by e.ord;

-- Catalog-wide invariants (7)
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
select is_empty(
  $$select c.conrelid::regclass::text
    from pg_constraint c
    join tenant_tables t on c.conrelid = format('public.%I', t.name)::regclass
    where c.contype = 'f'
      and c.confrelid = 'public."user"'::regclass
      and t.name <> 'workspace_members'$$,
  'tenant tables name users only through workspace_members, so every user they name is a member'
);
select is_empty(
  $$select c.conrelid::regclass::text
    from pg_constraint c
    where c.contype = 'f'
      and c.confrelid = 'public.workspace_members'::regclass
      and (
        (has_table_privilege('earshot_app', c.conrelid, 'INSERT') and not exists (
          select from pg_policy p
          where p.polrelid = c.conrelid and not p.polpermissive and p.polcmd in ('a', '*')
        ))
        or (has_table_privilege('earshot_app', c.conrelid, 'UPDATE') and not exists (
          select from pg_policy p
          where p.polrelid = c.conrelid and not p.polpermissive and p.polcmd in ('w', '*')
        ))
        or (has_table_privilege('earshot_app', c.conrelid, 'DELETE') and not exists (
          select from pg_policy p
          where p.polrelid = c.conrelid and not p.polpermissive and p.polcmd in ('d', '*')
        ))
      )$$,
  'every table the app writes that names a member binds that member to app.user_id'
);

-- Grants: exactly what each tenant table needs; read-only membership, and an append-only
-- audit log, checkpoints, event log, approval policies, and the mirror's history (16)...
select table_privs_are(
  'public', t.name::name, 'earshot_app', t.privs,
  format('earshot_app has exactly %s on %s', array_to_string(t.privs, ', '), t.name)
)
from tenant_tables t order by t.ord;

-- ...with UPDATE on workspaces granted for the name column alone (3)...
select column_privs_are(
  'public', 'workspaces', c.col::name, 'earshot_app', c.privs,
  format('earshot_app has exactly %s on workspaces.%s', array_to_string(c.privs, ', '), c.col)
)
from (values
  (1, 'id', '{SELECT}'::name[]),
  (2, 'name', '{SELECT,UPDATE}'::name[]),
  (3, 'created_at', '{SELECT}'::name[])
) as c(ord, col, privs)
order by c.ord;

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
