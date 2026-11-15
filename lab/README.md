# Earshot lab

Python 3.13, managed with [uv](https://docs.astral.sh/uv/). This is where CRM-Capture-Bench, the two-witnesses experiments, and model training will live (Phase 4 and Phase 8).

For now it holds the generated Pydantic contracts and the parity tests.

- `src/earshot_lab/contracts/` is generated from `packages/core/schemas/` by `scripts/gen_contracts.py`. Don't edit it by hand; run `pnpm contracts:gen` from the repo root.
- `tests/test_contracts.py` runs the shared fixtures in `packages/core/fixtures/` through Pydantic in strict JSON mode. The same fixtures run through Zod in `packages/core/test/`. If the two languages disagree about a fixture, one suite fails.

```bash
uv sync                 # create .venv with Python 3.13
uv run pytest           # parity tests
uv run ruff check .     # lint
pnpm --filter @earshot/lab typecheck   # pyright
```
