# ADR-0007: CRM writes happen only through approved proposals

## Status

Accepted (2026-11-15)

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

## More information

Phase 1 contains no proposals or adapters. HubSpot, Twenty, and Attio adapters arrive in Phase 6.
