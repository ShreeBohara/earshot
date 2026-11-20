-- Migration 0014 (Phase 5 WP3): the focus account stays inside its workspace and clears when its
-- record goes, a correction's `superseded` status and the review modes are allowed, and nothing
-- else is. As workspace A, through row-level security, as the app writes.
begin;
select plan(9);

set local role earshot_app;
select set_config('app.user_id', 'user-a', true),
       set_config('app.workspace_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

-- The focus account: one of A's records, never B's.
select lives_ok($$update sessions set focus_entity_id = 'a0000000-0000-4000-8000-000000000003'
  where id = 'a0000000-0000-4000-8000-000000000004'$$,
  'sessions: A can name one of its own records as the focus account');
select throws_ok($$update sessions set focus_entity_id = 'b0000000-0000-4000-8000-000000000003'
  where id = 'a0000000-0000-4000-8000-000000000004'$$,
  '23503', null, 'sessions: A can''t name one of B''s records as its focus account');
-- Deleting the record clears the focus account, and only it: the session stays A's.
select lives_ok($$delete from crm_entities where id = 'a0000000-0000-4000-8000-000000000003'$$,
  'crm_entities: A can delete the focus record');
select results_eq($$select focus_entity_id, workspace_id::text from sessions
  where id = 'a0000000-0000-4000-8000-000000000004'$$,
  $$values (null::uuid, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')$$,
  'sessions: deleting the focus record clears focus_entity_id and nothing else');

-- The status a correction leaves behind, and the review modes.
select lives_ok($$update proposals set status = 'superseded', superseded_by = gen_random_uuid()
  where id = 'a0000000-0000-4000-8000-000000000007'$$,
  'proposals: superseded is a status');
select throws_ok($$update proposals set status = 'snoozed'
  where id = 'a0000000-0000-4000-8000-000000000007'$$,
  '23514', null, 'proposals: a status outside the list is refused');
select lives_ok($$update proposals set review_mode = 'policy', policy_id = gen_random_uuid()
  where id = 'a0000000-0000-4000-8000-000000000007'$$,
  'proposals: policy is a review mode');
select throws_ok($$update proposals set review_mode = 'auto'
  where id = 'a0000000-0000-4000-8000-000000000007'$$,
  '23514', null, 'proposals: a review mode outside the list is refused');
-- The seal's time is the session's own to set (rebuildProjections writes it from the log).
select lives_ok($$update sessions set sealed_at = now()
  where id = 'a0000000-0000-4000-8000-000000000004'$$,
  'sessions: A can record its session''s seal');

select * from finish();
rollback;
