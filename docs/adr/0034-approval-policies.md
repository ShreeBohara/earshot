# ADR-0034: Approval policies: per type and field, versioned, a signed snapshot per session, applied at creation, reopened by later flags

## Status

Proposed (2026-11-25). Phase 5 WP11 built it (below): the `ApprovalPolicyRules` contract and its writer's checks, migration 0016's `approval_policies`, `PUT /api/policies` behind a 5-minute step-up with its `policy.changed` audit entry and checkpoint, the snapshot `POST /api/sessions` signs into each new session and `start.policy` carries, `SessionDO` verifying it and approving each new proposal a rule matches in the turn's own transaction, Settings → Review's policy, and Reviewed's "Approved by your policy: notes" with Undo. It builds the step-up ADR-0033 left to WP11. WP14 amends ADR-0006 (the step-up), ADR-0007 (policies made concrete), ADR-0019 (a new tenant table), and ADR-0024 (`start.policy`).

## Context and problem

Every proposal waits for the rep today. Some kinds are frequent and cheap to get wrong, a note above all, and a workspace wants those through without a look, while some fields, such as a deal's amount and stage, always come before a person (spec decision 5, the plan's principle 2). ADR-0007 keeps CRM writes behind approved proposals; a policy is an approval made in advance, so it has to be as accountable as a person's.

What a policy has to work within:

- **No database on the turn path.** `SessionDO` makes proposals from what `start` gave it and reads no Postgres while a turn runs (ADR-0024).
- **The client is untrusted.** A browser mustn't be able to claim a policy its workspace doesn't have, a looser one, or one from another session.
- **Tickets are small.** A session ticket is capped at 1,024 characters (ADR-0023), too small for a policy.
- **The tiers decide what's marked** (ADR-0035). A policy mustn't take anything a card would mark, the name note included: that's where silent wrong accounts hide (ADR-0039's flag-follower bound).
- **Every approval is on the chain** (ADR-0033), and an auto-approval has to say which policy, version, and rule made it.
- **Changing a policy changes what reaches the CRM with no one looking.** That needs more than a session cookie, but not a passkey per approval (decision 4).
- **Phase 6 syncs approvals.** An auto-approval has to follow the same rule as a person's: sealed sessions only, not before `syncEligibleAt`, the latest review re-read first.

## Considered options

- **Where a policy is applied:** **`SessionDO`, as each proposal is created, from a snapshot signed into the session (chosen)**; a Postgres read at `start` (the object reads no database on the turn path); the policy inside the ticket (1,024 characters); the inbox at review time (a person still opens the inbox, and the tray would show what the policy should take); the flush consumer (the tray wouldn't know, and the log would disagree with what the rep saw).
- **How the snapshot is protected:** **HMAC-SHA256 with the ticket secret over a prefix and the canonical snapshot bound to the session (chosen)**; unsigned (any client could claim any policy); signed without the session id (it would replay into any session); Ed25519 with the audit key (the audit key signs checkpoints; the ticket secret is already on both Workers).
- **What a rule can say:** **a proposal type, and fields that hold a proposal back (chosen, spec §4.6)**; value conditions such as "amounts under $10,000" (they'd read a value the faithfulness check may have replaced; later, if ever); rules per record or account (no CRM metadata yet).
- **What a rule can't override:** **the tiers, the link, and supersedes, always (chosen)**; letting a rule take quiet notes (the name note is where wrong accounts go unmarked).
- **The step-up:** **a sign-in from the last 5 minutes by any method Earshot recorded, with "Confirm with your passkey" on the page and an email link or the provider for an account without a passkey (chosen)**; a passkey only (accounts without one couldn't change a policy); Better Auth's fresh hour (too long for what a policy can do).
- **Versions:** **append-only, one row per version, the latest is the policy (chosen)**; one row updated in place (no history, and the chain would name versions that no longer exist).
- **A later conflict:** **reopened like any approval, `mode: "system"`, `reason: "flagged"` (chosen, decision 15)**; left approved for Phase 6.
- **Testing the step-up:** **route tests on fresh and stale sign-in sessions, a passkey's made through Better Auth's real handler with a software authenticator (chosen)**; Playwright with a virtual WebAuthn authenticator (no e2e suite exercises passkeys yet).

## Decision

### The contract (`packages/core`)

- **`ApprovalPolicyRules`** (spec §4.6): `{ v: 1, autoApprove: [{ id, type, alwaysReview }] }`, at most 12 rules of at most 10 fields; an id is 1–40 lowercase letters, digits, and hyphens; a field is a camelCase name of at most 64 characters. A contract: exported to JSON Schema and Pydantic, structural with no refinements, with parity fixtures in Vitest and pytest. "Auto-approve notes; always review amounts and stages" is `{ v: 1, autoApprove: [{ id: "notes", type: "note", alwaysReview: [] }, { id: "deal-updates", type: "deal_update", alwaysReview: ["amount", "stage"] }] }`.
- **`checkPolicyRules`**, the rules the schema can't express, which the writer runs: each id once (auto-approvals name their rule by it); one rule per type; each field one of its type's (`PROPOSAL_TYPE_FIELDS`, which a test in `@earshot/agent` holds to the extractor's tool schema), listed once; and no id shaped like a provider key, since the policy rides in `start`, which the socket refuses if anything in it looks like one.
- **`start.policy`** (`PolicySnapshot`): `{ id, version, rules, sig }`, optional. The key guard covers it like the rest of `start`.
- **The signature** (`signPolicySnapshot`, `verifyPolicySnapshot`): `sig` is base64url HMAC-SHA256 with `EARSHOT_SESSION_TICKET_SECRET` over `"earshot.policy.v1." + canonicalJson({ id, version, rules, sid })`. `canonicalJson` sorts object keys at every level by UTF-16 code unit and writes no whitespace and every scalar as `JSON.stringify` does: RFC 8785's form for the values a policy holds. Verifying needs the canonical base64url of exactly 32 bytes and compares with WebCrypto's `verify`, in constant time. The prefix keeps the secret's two uses apart: a ticket's HMAC covers base64url text, which never holds the prefix's dots. A test shows a ticket's signature doesn't pass for a snapshot's.

### Storage (migration 0016)

- **`approval_policies`**: `workspace_id`, `id`, `version`, `rules`, `rules_sha256`, `created_at`, `created_by`, keyed by `(workspace_id, version)`, so no workspace can take another's version numbers; checks keep versions positive and the hash 64 lowercase hex digits. drizzle-kit generated the table; by hand: `created_by` references the membership with `ON DELETE SET NULL (created_by)`, as `audit_log`'s actor does; row-level security (`tenant_isolation`); a RESTRICTIVE `actor_insert` binding `created_by` to `app.user_id`; and `SELECT` and `INSERT` only. A tenant table: exported with the account, deleted with the workspace, covered by pgTAP's structure, read, and fail-closed files, and by `96_approval_policies.sql` (append-only, inside its workspace, in the user's own name, the checks, a departed author cleared).
- **The policy's id** is the same for every version of a workspace's policy: the writer gives the first version a new UUIDv7 and every later one the same.
- **`rules_sha256`** is the lowercase hex SHA-256 of `canonicalJson(rules)`, which anyone can recompute from an export.
- **The data layer** (`packages/db/src/policies.ts`): `readApprovalPolicy` returns the latest version, null, or `invalid` for stored rules that no longer parse, which every caller treats as no policy. `writeApprovalPolicy` checks the rules again, needs a signer (`AuditUnavailableError` otherwise, before writing), takes a per-workspace advisory lock, refuses a change made from an older version (`stale`), writes nothing for rules equal to the latest version's, and otherwise appends the next version, a `policy.changed` audit entry (subject `approval_policy`, detail `{ policyId, version, rulesSha256, auth: { method, signedInAt } }`) in the viewer's name, and a checkpoint (`request: "policy"`). The lock order is the policy lock, then the audit trigger's.

### Changing a policy: `PUT /api/policies`

`apps/web/lib/policies/routes.ts`, in order: same-site only (403); the step-up (403 `step_up_required`, before the body is read); at most 16 KiB (413); `{ rules, baseVersion }` (`PolicyRouteRequest` in `@earshot/core`, TypeScript-only like the review route's) holding to `checkPolicyRules` (400, quoting nothing); a usable signing key (503 `audit_unavailable`, before the database); then `writeApprovalPolicy` in the viewer's tenant transaction (409 `stale` with the current version). It answers `{ policy, changed }`. Logs carry counts and codes only.

### The step-up

- **The rule** (`lib/auth/fresh.ts`): `STEP_UP_SECONDS` is 300 (target), and `isSteppedUp` asks for a sign-in session that began less than 5 minutes ago, by a method other than `unknown`, so the change's audit entry can say how its author signed in. Better Auth sets a session's `createdAt` at sign-in and never moves it (a refresh extends `expiresAt` on the same row), the same field its own fresh check reads.
- **The page:** while the sign-in is older, Settings → Review's switches are off and it offers:
  - **"Confirm with your passkey"** when the account has one: `authClient.signIn.passkey()` signs in again right there (signed in, Better Auth's options name only this account's passkeys), and the page refreshes with the new sign-in;
  - **"Email me a sign-in link"** for an account without one: a magic link to the account's own address, back to the page;
  - **"Other ways to sign in"**: the sign-in-again page (`/sign-in?reauth=1`), with every method the deployment offers.
- **Accounts that sign in only with GitHub or Google** sign in again there, with that provider, or by an email link to the address the provider gave, whichever the deployment offers (an email link needs Resend outside development). Any recorded method counts.

### The snapshot

- **`POST /api/sessions`** reads the latest version in the session's own tenant transaction, before the entities, which it budgets around the snapshot so `start` still fits 64 KiB. No policy, a policy that approves nothing, or stored rules that don't parse (logged) give `policy: null`. Otherwise it answers `policy`, signed for the new session's id. A policy of one rule per type takes about 540 bytes of `start`.
- **A signature shaped like a key.** A signature is random base64url, so about one in 100,000 could happen to contain a provider key's shape (`sk-` and 20 characters, say), and the socket would refuse the session's `start`. That session gets no policy instead, which is logged, and every proposal waits for the rep.
- **The client:** the capture controller sends the snapshot in `start.policy`, fake mode included (the snapshot isn't part of any turn's request, so cassettes still answer); `SessionClient.sendStart` takes it.

### `SessionDO`

- **`start`:** the snapshot must verify against the object's own session id, with the ticket secret (`readTicketKey`, imported once per isolate). A forged snapshot, one signed for another session, or one signed with another secret refuses the `start` with `bad_message`, not retryable, and nothing is remembered: a valid one may follow. One that verifies is kept in `meta` as `{ id, version, rules }`, never its signature. A secret that can't be read refuses with `internal`; the socket route would have refused the ticket first. A second `start`'s snapshot changes nothing: the session keeps the policy it started with, and a change applies from the next session.
- **Each turn:** before the call, the policy and whether the audit signing key is usable. Without a key no policy applies, and the log says so: the flush couldn't store the approvals with their audit rows (fail closed, ADR-0033). After `understand()`, each new proposal is folded into the session's proposals and run through `policyRuleFor` (`@earshot/events`): `tierOf` must be `none` (no loud reason, no quiet note, no name note), the target `linked` (a contact's is its name), nothing superseded, and a rule for the type that holds back none of the fields the proposal carries. A field the model left out isn't on the proposal, so it holds nothing back. The first matching rule wins.
- **The approval** is checked with `checkReview` (`from: "session"`) and appended right after its proposal, in the turn's own commit: `proposal.reviewed` v2, `decision: "approved"`, `target: null`, `mode: "policy"`, `policy: { id, version, rule }`, `by` the session's user with `auth: null`, `input: "none"`, `surface: "session"`, timings 0, `seen` as the proposal stands, and `syncEligibleAt` the object's clock plus the undo window. Its id goes in `writes`, so no client can reuse it. If the registry refused an approval (a bug), the turn's proposals are kept, unapproved.
- **A later flag** reopens it as any approval (decision 15): `mode: "system"`, `reason: "flagged"`, naming the policy's review.
- **Logs:** the turn's line adds how many were approved and why the rest weren't, as counts by reason.

### The audit chain

No new code: the flush consumer's `recordReviewAudit` gives each auto-approval a `proposal.auto_approved` row in the session's user's name, its detail naming the policy's id, version, and rule, `auth: null`, the `session` surface, and input `none`, signed by the flush message's checkpoint. A policy's change has its own `policy.changed` row and checkpoint (above).

### What the rep sees

- **Settings → Review:** per type, "Auto-approve notes" (and the others) with an example, and once it's on, "Always review deal updates with" and its fields, each with an example. A type's main field (a note's text, a task's title) is on every proposal of it, so it isn't offered: holding it back would approve nothing. The page says what a policy never takes, the current version and who changed it when, and that a change applies from the next debrief. Save writes one rule per type that's on, keeping a rule's id from the policy, and new rules take the type's plural (`notes`, `deal-updates`).
- **Reviewed:** "Approved by your policy: notes · Note for Acme Corp", with Undo until `syncEligibleAt`, then Reopen. Either sends a reopen naming the policy's review (`mode: "single"`, `reason: "undo"`), like any other. The inbox's loader carries the review's policy; the tray reads it from the session's events.

### What a policy never does

- Approve a marked card (loud, a quiet note, or the name note), a question, a new record, a proposal with no record, or a correction.
- Approve without a snapshot that verified for this session, or without a signing key.
- Change a session already under way.
- Sync anything. Phase 6's rule applies to auto-approvals as to a person's: a sealed session, a latest review that approves, not before `syncEligibleAt`, re-read before writing.

### Where this departs from the spec

1. **The writer's checks.** The spec's contract is kept, plus a 64-character cap on field names, and `checkPolicyRules` at the route: one rule per type, each field one of its type's, unique ids, no key-shaped id. Evaluation still takes the first matching rule, as the spec says.
2. **Optimistic concurrency.** `PUT /api/policies` takes `baseVersion` and answers 409 `stale`, so two tabs can't overwrite each other; rules equal to the latest version's write nothing.
3. **The step-up needs a recorded method** as well as a sign-in from the last 5 minutes.
4. **No snapshot** for a policy that approves nothing, for stored rules that don't parse, or when the signature happens to look like a key.
5. **The audit entry's shape:** `policy.changed`, subject `approval_policy`, detail `{ policyId, version, rulesSha256, auth }`.
6. **The table's key and author.** `(workspace_id, version)`, and `created_by` bound to the transaction's user by an actor policy and to a membership by a foreign key, as `audit_log`'s actor is.
7. **The Reviewed line** reads "Approved by your policy: notes · Note for Acme Corp": the rule's words, then the card.
8. **The step-up's test** is route-level, not Playwright, as the brief allowed when no e2e suite exercises passkeys.

## Consequences

**Good**

- Low-risk proposals skip the queue with the same trail as a person's approval: a v2 review naming the policy, version, and rule, an audit row, Undo in Reviewed, and the same sync rule.
- A client can't forge a snapshot, loosen one, or carry one into another session, and an old browser can't apply an old policy to a new session.
- Nothing a card would mark is auto-approved: one tier function decides for the cards, "accept all", and policies.
- No new secret, dependency, or database read on the turn path; the object still decides from `start` alone.
- Every change is a version, an audit entry with the rules' hash and how its author signed in, and a checkpoint.
- **Bundle:** the edge Worker's dry-run bundle grows from 2,837.86 KiB to 2,850.13 KiB, gzip 543.14 to 546.10 KiB: +12.27 KiB, +2.96 KiB gzipped.

**Bad**

- A change waits for the next session: a live debrief keeps its policy, even one the rep just turned off. Undo, and Phase 6's sync rule, cover the gap.
- The step-up asks again after 5 minutes, and a rep without a passkey leaves the page for an email.
- An auto-approved proposal never becomes an open card in the tray, so when it's a turn's first proposal, that turn sends no `turn.measured` (the paint mark never comes). Not a human timing, but a gap in latency metrics on workspaces with policies.
- About one session in 100,000 runs without its policy, when its signature looks like a key.
- Nothing in the schema keeps a workspace's versions under one id; the writer does.
- Any member could change the workspace's policy. Phase 5 has one member per workspace; roles come with team workspaces.
- Passkeys aren't exercised in a browser yet: the step-up's passkey path is tested at the route, through Better Auth's real handler.

## More information

- Spec: Phase 5 build spec §4.6, WP11, decisions 4, 5, 15, and 16, §4.3, §4.4, and §8's policy rows.
- Contract and snapshot: `packages/core/src/contracts/{approval-policy,policy-route}.ts`, `packages/core/src/policy-snapshot.ts`, `PolicySnapshot` in `session-protocol.ts`.
- Evaluation: `packages/events/src/policy.ts` (`policyRuleFor`); the table in `packages/events/test/policy.test.ts`, on `tierOf` itself.
- Storage: `packages/db/migrations/0016_approval_policies.sql`, `packages/db/src/{schema/policies,policies}.ts`, `packages/db/test/{policies.test.ts,pgtap/96_approval_policies.sql}`.
- The writer and the snapshot: `apps/web/lib/policies/routes.ts`, `app/api/policies/route.ts`, `lib/auth/fresh.ts`, `lib/voice/routes.ts`; tests in `apps/web/test/policy-routes.test.ts`.
- `SessionDO`: `apps/edge/src/session-do.ts`; tests in `apps/edge/test/sessions/policies.test.ts` (real eval debriefs) and `apps/edge/test/node/flush.test.ts` (the audit row).
- The page: `apps/web/components/policies/approval-policy-settings.tsx`, `lib/policies/copy.ts`, `app/(app)/settings/review/page.tsx`; Reviewed in `components/inbox/inbox-sections.tsx`; end to end in `apps/web/e2e/capture/approval-policy.spec.ts`.
- ADR-0007, ADR-0019, ADR-0023, ADR-0024, ADR-0032, ADR-0033, ADR-0035.
