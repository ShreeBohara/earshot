# ADR-0011: TypeScript for the product, Python for the lab, JSON Schema contracts between them

## Status

Accepted (2026-11-15). Amended for Phase 3 (2026-11-15): some contracts are TypeScript-only; see "More information".

## Context and problem

The product spans web, edge, and later mobile, and the research work (the benchmark, experiments, training) lives in Python. The two sides must agree on data shapes, such as events and proposals, without hand-maintained duplicates.

## Considered options

- **TypeScript for the product, Python only for the lab, with shared JSON Schema contracts.**
- A Python backend, which splits the contracts.
- C++, since nothing in the system needs it.

## Decision

Write all of the product in TypeScript. Use Python 3.13, managed with uv, for the lab. Define contracts once, as Zod v4 schemas in `packages/core`. They export to JSON Schema, which generates Pydantic models for the lab. Shared fixtures, split into valid and invalid, run in both Vitest and pytest to prove both languages accept and reject the same data. CI runs `pnpm contracts:gen && git diff --exit-code` to catch drift.

Turborepo's Python support is experimental, so `lab/` has a small `package.json` whose scripts call uv.

Rust or WASM would be considered only if profiling finds a hotspot.

## Consequences

**Good**

- One language end to end for the product, with one source of truth for contracts.
- Python where the ML tooling is.

**Bad**

- A generation step, and a drift check, to maintain.
- Zod and Pydantic differ on details such as timestamp formats and extra keys, which the parity fixtures exist to catch.
- Two toolchains in one repository.

## More information

After changing a contract, run `pnpm contracts:gen` and commit the result.

**TypeScript-only contracts (Phase 3).** Not every Zod schema in `packages/core` is exported; the `contracts` map in `src/contracts/index.ts` lists the ones that are.

- The session socket protocol (`ClientMessage`, `ServerMessage`) and session ticket claims aren't exported. Only TypeScript speaks them: the browser, the edge Worker, and `SessionDO`. Their key checks also have no JSON Schema form: the protocol refuses a key-shaped string anywhere except `turn_end.key`, and a ticket is only as good as its HMAC. Exported, they would accept data that Zod refuses, so parity fixtures for those checks could only fail. They're tested in Vitest alone.
- Exported contracts set no maximum string lengths. Zod counts a string's length in UTF-16 code units and JSON Schema counts code points, so a cap would make the two languages disagree about text with emoji or other characters outside the Basic Multilingual Plane. Caps live in the TypeScript-only socket schemas instead, for example the 4,000-character limit on an utterance's text.
