# ADR-0007: CRM writes happen only through approved proposals

## Status

Accepted (2026-11-15). Amended for Phase 5 (2026-11-25): how a proposal gets approved is now concrete, with review modes, "accept all", approval policies, undo, and the boundary Phase 6's sync must respect. See "Amendment: Phase 5" below, ADR-0032, ADR-0034, and ADR-0035.

## Context and problem

Speech recognition and language models make mistakes. A write to the wrong account is the worst possible error, and transcripts and CRM text are untrusted input that may carry prompt injection. Earshot's central promise is that nothing touches the CRM without approval.

## Considered options

- **Proposals only: the model creates proposals, a human approves them, and typed REST adapters write.**
- Letting the model call CRM write APIs directly, including through MCP.

## Decision

Model output can only create proposals. Write tools such as `propose_note`, `propose_task`, `propose_contact`, `propose_deal_update`, and `log_commitment` produce proposal records, each field carrying its evidence (utterance ID, character span, audio offsets, confidence). A human approves, and only then does a typed REST adapter write to the CRM.

Users can set approval policies by type and field that auto-approve low-risk items they choose, such as notes, while amounts and stages stay under review. Tools are allowlisted and output is encoded.

## Consequences

**Good**

- Safe against model mistakes and prompt injection.
- Works with any CRM, with no dependence on its MCP support.
- Every change has evidence and an audit trail.

**Bad**

- Approval adds a step. The review experience must be fast: Phase 5 targets a median review time under 4 seconds per proposal.
- Approving many items at once can reduce scrutiny, so per-item review is the default, with "accept all from this call" behind a checkpoint and undo.
- Typed adapters must be written and maintained per CRM.

## Amendment: Phase 5 (2026-11-25)

Phase 5 builds the approval half of this decision; nothing writes to a CRM until Phase 6.

- **Who approves, and how it's recorded.** Every decision is a `proposal.reviewed` v2 event (ADR-0032) with a mode: `single` (a person, one card), `batch` (a person's "accept all"), `policy` (an approval policy, as the proposal is made), or `system` (`SessionDO` reopening an approval a later witness flag put in doubt). Clients can write only the first two. Each review says what the reviewer saw, the record they chose, how long it took, and how they signed in, and every review, a rejection or a reopen included, is a row on the workspace's audit chain under a signed checkpoint (ADR-0033). Snoozes and corrections decide nothing, so they write no row.
- **"Accept all from this call"** (ADR-0035) takes only the cards `tierOf` leaves unmarked that have a record, as one batch: one `batchId`, one review per card, one undo. The checkpoint is structural, not a confirm dialog: the inline list says what will be accepted and what stays, and every marked card stays for one-by-one review. The writers refuse a batch item with a marker, so the page can't take more than the rule allows.
- **Approval policies, made concrete** (ADR-0034). Per workspace, versioned, and append-only: per proposal type, with fields that always need review ("auto-approve notes; always review amounts and stages"). A policy approves only a proposal with no marker of any kind (not even the name note), linked to a record, replacing nothing, and carrying none of its rule's held-back fields. `SessionDO` applies the snapshot the web app signed into the session's `start`, so a client can't claim a looser one; changing a policy needs a sign-in from the last 5 minutes (ADR-0006), and every change is a version, an audit entry, and a checkpoint. Every auto-approval names its policy, version, and rule.
- **Undo is a later event, never a deletion.** A reopen (`decision: "reopened"`, `undoes` naming the review it reverses) puts the card back; undoing a batch reopens each card it still stands on. Reviewed keeps Undo until the approval's sync window closes, then offers Reopen. A witness flag on an approved card reopens it the same way (`mode: "system"`).
- **Corrections decide nothing.** A correction (ADR-0038) makes a new proposal that supersedes the card, for the rep to review; every writer refuses a review of a superseded proposal, and no policy approves a proposal that supersedes another.
- **The sync boundary.** Each approval and edit records `syncEligibleAt`, its time plus 30 s (`UNDO_WINDOW_MS`, target). Phase 6's outbox syncs only proposals whose session is sealed and whose latest review approves or edits, never before `syncEligibleAt`, re-reads that review by its id right before writing, derives the idempotency key from the proposal and that review, and stops on a conflict when the CRM's live value moved from what the reviewer saw (`seen.current`, or `seen.base`). Auto-approvals follow the same rule. Nothing syncs in Phase 5.
- **The review time.** The plan's median under 4 s per proposal is gate G1. Phase 5 has a $0 proxy, the scripted reviewer's KLM estimate on the pilot's cards, which is 6.49 s, over the target; the five-person pilot measures it (ADR-0039).

## More information

Phase 1 contains no proposals or adapters. HubSpot, Twenty, and Attio adapters arrive in Phase 6.
