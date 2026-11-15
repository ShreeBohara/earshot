# ADR-0015: MIT license

## Status

Accepted (2026-11-15)

## Context and problem

Earshot is open source and meant to be self-hosted, and its adapter SDK invites community contributions. The project needs a license that is simple for users and contributors to understand. v1 was already MIT licensed.

## Considered options

- **MIT.**
- AGPL.

## Decision

Keep the MIT license for the code. It is the same license v1 used and the simplest choice. The benchmark follows plan §7.2: the harness is MIT-licensed, and the dataset is released under CC-BY-4.0 with a datasheet.

## Consequences

**Good**

- Anyone can use, modify, host, and redistribute Earshot, including self-hosters and adapter authors, with few conditions.
- No change from v1.

**Bad**

- MIT has no copyleft: a third party can run a modified, closed hosted version without sharing changes. AGPL would have required that.
- The project gives up a lever against hosted forks.

## More information

The plan says Earshot's lasting value is as an open, auditable reference implementation of verified write-back, plus the benchmark that measures it, rather than as a business. That framing fits a permissive license.
