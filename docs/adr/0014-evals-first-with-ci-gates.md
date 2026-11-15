# ADR-0014: Evals first, with CI gates

## Status

Accepted (2026-11-15)

## Context and problem

Voice models and prices change every few months, and word error rate does not predict whether the resulting CRM actions are correct. A 2026 study found that real transcription errors lower tool-call accuracy, and that numbers and negations cost the most. Prompts tuned by feel can regress without anyone noticing. v1 had no evals or end-to-end tests, and its unit-test harness (PR #5) came last.

## Considered options

- **Evals first, with CI gates and replay-based deterministic tests.**
- Changing prompts and models by feel.

## Decision

Measure every prompt or model change, and gate merges on the result.

- **Phase 3:** eval harness v0, with 30 synthetic debriefs fed to Chrome's fake microphone. CI replays recorded model responses, and only a nightly job uses a live key.
- **Phase 4:** harness v1, with 200 synthetic debriefs. A 30-sample smoke eval runs in CI on any PR that touches prompts or agent code, with a budget guard. A regression of more than 3 points blocks the merge.
- **Phase 8:** CRM-Capture-Bench, with a real, consented split reported next to the synthetic one.

Phase 1 makes no model calls and spends nothing, so only the CI structure and test tooling are set up now.

## Consequences

**Good**

- Regressions are caught before merge, and model or provider swaps can be re-evaluated quickly.
- Replay makes CI deterministic and cheap.

**Bad**

- Building the harness and datasets takes time before features ship.
- A synthetic benchmark can flatter the system, so real recordings are needed.
- Budget guards and caching add their own machinery.

## More information

PR #5's tool and store cases can seed Phase 4's eval fixtures.
