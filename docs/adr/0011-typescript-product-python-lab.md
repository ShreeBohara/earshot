# ADR-0011: TypeScript for the product, Python for the lab, JSON Schema contracts between them

## Status

Accepted (2026-11-15)

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
