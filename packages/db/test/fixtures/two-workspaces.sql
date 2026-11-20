-- Two tenants, A and B, each with one row in every tenant table, inserted as the owner (RLS
-- doesn't apply to it). Ids are fixed so tests can name them:
--   workspace A = aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa, user user-a
--   workspace B = bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb, user user-b
--   A's rows are a0000000-0000-4000-8000-0000000000NN and B's are b0000000-…NN, where NN is
--   01 credentials, 02 crm_connections, 03 crm_entities, 04 sessions, 05 session_events,
--   06 utterances, 07 proposals, 08 sync_jobs, 09 commitments, 10 facts, 11 audit_log,
--   12 audit_checkpoints. The audit log's trigger (migration 0013) gives each entry chain_seq 1;
--   each checkpoint names it, with a placeholder signature (nothing here verifies it).

insert into "user" (id, name, email) values
  ('user-a', 'Ada Archer', 'ada@a.test'),
  ('user-b', 'Bo Baker', 'bo@b.test');

insert into workspaces (id, name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Workspace A'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Workspace B');

insert into workspace_members (workspace_id, user_id, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-a', 'owner'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'user-b', 'owner');

insert into credentials
  (id, workspace_id, provider, label, ciphertext, iv, wrapped_dek, dek_iv, last4)
values
  ('a0000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'openai', 'default', '\x0a01', '\x0a02', '\x0a03', '\x0a04', 'aaaa'),
  ('b0000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   'openai', 'default', '\x0b01', '\x0b02', '\x0b03', '\x0b04', 'bbbb');

insert into crm_connections
  (id, workspace_id, provider, auth_type, ciphertext, iv, wrapped_dek, dek_iv, api_version)
values
  ('a0000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'hubspot', 'service_key', '\x0a11', '\x0a12', '\x0a13', '\x0a14', '2026-09'),
  ('b0000000-0000-4000-8000-000000000002', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   'twenty', 'api_key', '\x0b11', '\x0b12', '\x0b13', '\x0b14', null);

insert into crm_entities
  (id, workspace_id, connection_id, kind, external_id, name, aliases, phonetic_keys, embedding)
values
  ('a0000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'a0000000-0000-4000-8000-000000000002', 'company', 'hs-101', 'Acme',
   '{"Acme Corp"}', '{AKM}', array_fill(0.1::real, array[512])::halfvec),
  ('b0000000-0000-4000-8000-000000000003', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   'b0000000-0000-4000-8000-000000000002', 'company', 'tw-201', 'Atlas',
   '{}', '{ATLS}', array_fill(0.2::real, array[512])::halfvec);

insert into sessions (id, workspace_id, user_id, mode, engine) values
  ('a0000000-0000-4000-8000-000000000004', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'user-a', 'debrief', 'cascaded'),
  ('b0000000-0000-4000-8000-000000000004', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   'user-b', 'debrief', 'cascaded');

insert into session_events
  (id, workspace_id, session_id, seq, type, schema_version, payload, ts)
values
  ('a0000000-0000-4000-8000-000000000005', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'a0000000-0000-4000-8000-000000000004', 0, 'utterance.final', 1,
   '{"text": "Met Dana Lee at Acme."}', '2026-11-15T17:30:00Z'),
  ('b0000000-0000-4000-8000-000000000005', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   'b0000000-0000-4000-8000-000000000004', 0, 'utterance.final', 1,
   '{"text": "Called Sam at Atlas."}', '2026-11-15T18:00:00Z');

insert into utterances
  (id, workspace_id, session_id, seq, witness, text, confidence, started_ms, ended_ms)
values
  ('a0000000-0000-4000-8000-000000000006', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'a0000000-0000-4000-8000-000000000004', 0, 'biased', 'Met Dana Lee at Acme.', 0.94, 0, 1800),
  ('b0000000-0000-4000-8000-000000000006', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   'b0000000-0000-4000-8000-000000000004', 0, 'biased', 'Called Sam at Atlas.', 0.91, 0, 1500);

insert into proposals (id, workspace_id, session_id, type, target_entity_id, fields) values
  ('a0000000-0000-4000-8000-000000000007', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'a0000000-0000-4000-8000-000000000004', 'note', 'a0000000-0000-4000-8000-000000000003',
   '{"body": {"value": "Met Dana Lee.", "evidence": []}}'),
  ('b0000000-0000-4000-8000-000000000007', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   'b0000000-0000-4000-8000-000000000004', 'note', 'b0000000-0000-4000-8000-000000000003',
   '{"body": {"value": "Called Sam.", "evidence": []}}');

insert into sync_jobs (id, workspace_id, proposal_id, adapter, idempotency_key) values
  ('a0000000-0000-4000-8000-000000000008', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'a0000000-0000-4000-8000-000000000007', 'hubspot', 'a0000000-0000-4000-8000-000000000007:hubspot'),
  ('b0000000-0000-4000-8000-000000000008', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   'b0000000-0000-4000-8000-000000000007', 'twenty', 'b0000000-0000-4000-8000-000000000007:twenty');

insert into commitments (id, workspace_id, owner, counterpart, text, due_at) values
  ('a0000000-0000-4000-8000-000000000009', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'rep', 'Dana Lee', 'Send the security questionnaire', '2026-11-19T17:00:00Z'),
  ('b0000000-0000-4000-8000-000000000009', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   'prospect', 'Sam Ortiz', 'Share the budget', null);

insert into facts (id, workspace_id, entity_id, key, value, valid_from) values
  ('a0000000-0000-4000-8000-000000000010', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'a0000000-0000-4000-8000-000000000003', 'champion', '"Dana Lee"', '2026-10-03T00:00:00Z'),
  ('b0000000-0000-4000-8000-000000000010', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   'b0000000-0000-4000-8000-000000000003', 'champion', '"Sam Ortiz"', '2026-10-05T00:00:00Z');

insert into audit_log (id, workspace_id, actor_user_id, action, subject_type, subject_id) values
  ('a0000000-0000-4000-8000-000000000011', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'user-a', 'proposal.approved', 'proposal', 'a0000000-0000-4000-8000-000000000007'),
  ('b0000000-0000-4000-8000-000000000011', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   'user-b', 'proposal.approved', 'proposal', 'b0000000-0000-4000-8000-000000000007');

insert into audit_checkpoints
  (id, workspace_id, chain_seq, entry_hash, signed_at, kid, signature, request)
select v.id, a.workspace_id, a.chain_seq, a.entry_hash, '2026-11-15T19:00:00.000Z',
       'audit-test-fixture', decode(repeat('0a', 64), 'hex'), 'review'
from (values
  ('a0000000-0000-4000-8000-000000000012'::uuid, 'a0000000-0000-4000-8000-000000000011'::uuid),
  ('b0000000-0000-4000-8000-000000000012'::uuid, 'b0000000-0000-4000-8000-000000000011'::uuid)
) as v(id, audit_id)
join audit_log a on a.id = v.audit_id;
