# ADR-0000: Record decisions as MADR files in docs/adr

## Status

Accepted (2026-11-15)

## Context and problem

Earshot v2 starts with fifteen architectural choices, from the voice engine to the license, and several more arrive in Phase 1 (see the index in this folder). Without a written record, the reasons behind a choice get lost, and contributors can't tell which rejected options were already weighed. The record has to live with the code, be reviewed like code, and stay short enough that people write it.

## Considered options

- **MADR short form, one file per decision, in `docs/adr`.**
- A wiki or a shared document outside the repository.
- Notes in the README or in one long design document.
- No formal record.

## Decision

Use MADR's short form, kept in `docs/adr/` as `NNNN-<slug>.md` with a four-digit number. Each file has a title (`# ADR-NNNN: <decision>`) and these sections: Status, Context and problem, Considered options, Decision, Consequences (good and bad), and an optional More information.

The pull request template asks "Does this need an ADR?", and architectural changes require one.

## Consequences

**Good**

- Decisions are reviewed in pull requests, next to the code they affect.
- Rejected options are written down, so they don't get re-argued from scratch.
- The numbering gives every decision a stable name that code and docs can cite.

**Bad**

- Writing an ADR takes time, and short ones can still leave out context.
- Old ADRs can go stale if nobody notices a decision has changed.
- A reader has to open several files to see the whole architecture, which is why `docs/architecture.md` summarizes it.

## More information

See CONTRIBUTING.md for how to add an ADR.
