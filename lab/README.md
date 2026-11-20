# Earshot lab

Python 3.13, managed with [uv](https://docs.astral.sh/uv/). This is where CRM-Capture-Bench, the two-witnesses experiments, and model training will live (Phase 4 and Phase 8).

For now it holds the generated Pydantic contracts, their parity tests, and the eval renderer.

- `src/earshot_lab/contracts/` is generated from `packages/core/schemas/` by `scripts/gen_contracts.py`. Don't edit it by hand; run `pnpm contracts:gen` from the repo root.
- `tests/test_contracts.py` runs the shared fixtures in `packages/core/fixtures/` through Pydantic in strict JSON mode. The same fixtures run through Zod in `packages/core/test/`. If the two languages disagree about a fixture, one suite fails.
- `scripts/render_debriefs.py` renders the eval scripts in `packages/evals/debriefs/` to 48 kHz mono 16-bit WAVs with Kokoro, for Chrome's fake microphone (ADR-0026). Output goes to `.cache/wavs/` (gitignored), named by a hash of everything that shapes the audio, with a `timing.json` beside each WAV and a `manifest.json`. The model files download on first use to `.cache/kokoro/`, from the URLs and SHA-256s pinned in `scripts/kokoro_files.json` (about 354 MB). CI renders and caches them through `.github/actions/eval-wavs`.
- `scripts/debrief_noise.py` mixes background noise under a script that asks for it with `noise: { kind, snrDb }`: car (brown noise), street (pink noise), or cafe (babble of 3 to 5 other Kokoro voices over a pink floor), at that signal-to-noise ratio on the spoken samples (Phase 4 WP10b). It's procedural numpy, seeded, and joins the WAV's hash; scripts without noise render exactly as before. Recorded corpora (MUSAN, OpenSLR 28) stay optional, lab-only, and out of CI.

```bash
uv sync                 # create .venv with Python 3.13
uv run pytest           # parity and renderer tests (the renderer's use stand-in voices)
uv run ruff check .     # lint
pnpm --filter @earshot/lab typecheck   # pyright

# Rendering for real needs the tts group (kokoro-onnx and onnxruntime) and downloads the model:
uv sync --group tts
uv run --group tts python scripts/render_debriefs.py --prune
```
