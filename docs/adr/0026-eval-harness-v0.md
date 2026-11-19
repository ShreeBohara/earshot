# ADR-0026: Eval harness v0: synthetic debrief scripts, Kokoro rendered in CI, Chrome's fake microphone, cassettes, and $0 CI

## Status

Proposed (2026-11-19). The first half of WP11 is built: the scripts, the renderer, the CI render and cache step, and the cassettes. The second half adds the fake-microphone Playwright project, the smoke test, the eval wiring, the baselines, and the live workflow, then marks this ADR accepted.

## Context and problem

Phase 3's gate needs the fake-microphone end-to-end test running in CI (G3), and a latency baseline (G1a in CI, G1b in one live run). ADR-0014 commits to evals first: CI replays recorded model responses, and only an opt-in run uses live keys. The harness has to:

- exercise the real pipeline, from audio in the browser to proposal cards, on fixtures whose correct answer is known;
- cost $0 in CI, and never touch a real person or company;
- produce WAVs that Chrome's fake microphone accepts. It takes 8-, 16-, or 32-bit PCM, or 32- or 64-bit float, but rejects 24-bit. With `%noloop`, the last 1,024-frame buffer appears to repeat after the end of the file, so speech must not run to the end;
- keep the 354 MB of Kokoro model files out of the checks job that runs on every PR (spec decision 14).

## Considered options

- **Scripts: 30 hand-written JSON files with ground truth, checked by tests (chosen).** An LLM could write them, but its output wouldn't be reproducible and would need the same review. Real recordings wait for Phase 8 and consent.
- **Speech: kokoro-onnx 0.6.1 in the lab's `tts` uv group (chosen).** Its weights are Apache-2.0 and need no torch, and its 24 kHz output reaches 48 kHz by an exact 2× upsample. Alternatives:
  - kokoro-js would keep the toolchain all-JS, but it pins transformers.js 3.
  - Piper is GPL-3.0, its voices carry licensing caveats, and its 22.05 kHz output needs fractional resampling.
  - Pocket TTS needs torch and gated weights.
- **WAVs: rendered in CI and cached by content hash (chosen),** rather than committed (about 86 MB in git or LFS).
- **Cassettes: generated from the ground truth through the real adapters (chosen).** Recording live calls costs money, needs keys, and risks a key in a fixture. Live recordings come later, from the opt-in run, for review.

## Decision

### Scripts

- `packages/evals/debriefs/d001.json` to `d030.json`, validated at import by the Zod schema `DebriefScript` from `@earshot/evals`.
- Each script has:
  - 2 to 5 turns, one push-to-talk press each;
  - the pause before each turn;
  - a Kokoro voice;
  - the call time and the rep's time zone.
- Each turn lists the proposals it should yield. A proposal has a type, a target, and fields:
  - the target is a demo CRM id, or null for a new contact;
  - each field is a value, as the CRM should store it, and a quote, the exact words `attachEvidence` looks for.
- Every turn that has a target names it, by name or alias. The extractor sees only that turn's transcript, so "she" or "the deal" couldn't resolve.
- Tests check the ground truth itself:
  - every quote is a substring of its turn;
  - every target resolves by exact name, to a kind its proposal type allows;
  - every date is re-derived from its quote and the call time. Only unambiguous phrasings are accepted, so "next Friday" is refused;
  - every amount is parsed back from its quote;
  - `negation` and `self_correction` tags are backed by the text.
- Coverage minimums are enforced:

  | Rule | Minimum | Now |
  |---|---|---|
  | Turns that expect a proposal | 90 | 98 of 118 |
  | Proposals of each type | 5 | notes 31, tasks 22, deal updates 26, commitments 12, contacts 9 |
  | Scripts that name and target a confusable-group member | 10 | 27 |
  | Turns with numbers | 10 | 30 |
  | Turns with relative dates | 10 | 21 |
  | Turns with negations | 5 | 19 |
  | Turns with self-corrections | 2 | 4 |
  | Distinct voices | 12 | 26 |

- `KEY_FIELDS` names the fields an eval compares exactly: dates, amounts, stages, and contact details. Free text is the model's own wording: CI's cassettes reproduce it word for word, a live model won't, and Phase 4 scores it.

### Session context and cassettes

- A cassette key is a SHA-256 of the request's method, path, and canonical body (ADR-0025). The body carries three things:
  - the turn's transcript;
  - the session's entities: kind, name, and aliases, in order;
  - the call time, to the minute, in the rep's time zone.

  Utterance ids, timings, and confidences don't reach it.
- An eval session therefore runs with:
  - `DEMO_SESSION_ENTITIES`: the whole demo CRM, in the order `POST /api/sessions` gives a freshly loaded demo CRM with no account selected;
  - the script's call time and time zone.

  `sessionContext(script)` returns all three.
- `packages/evals/scripts/gen-cassettes.ts` writes the cassettes:
  - it builds each turn's model response from the ground truth, in Anthropic's tool-use and Groq's tool-call wire formats;
  - it runs the response through the real adapter and `runTurn` with `@earshot/agent/testing`'s `recordScenario`;
  - it writes one cassette per script and provider, in WP5's `CassetteFile` format, to `packages/evals/cassettes/`.
- Tests regenerate the cassettes and fail on drift. They also replay every turn and check that the proposals coming out (type, target id, and field values) are the script's.

### Rendering

- `lab/scripts/render_debriefs.py` renders each script:
  1. Kokoro speaks each turn at 24 kHz.
  2. The turns are joined, each after its pause, with a 1.0 s silent tail.
  3. `scipy.signal.resample_poly(audio, 2, 1)` upsamples it exactly 2×.
  4. Samples are clipped to [-1, 1] and written as 16-bit integers: a 48 kHz mono PCM WAV.
- Beside each `<hash>.wav` goes `<hash>.timing.json`, with each turn's offsets and approximate word offsets. Kokoro gives no word timings, so each turn's span is spread over its words by character count, by `spreadWords`'s rule.
- `manifest.json` maps script ids to files.
- The hash is 32 hex digits of SHA-256 over everything that shapes the audio:
  - the turns and their pauses;
  - the voice and speed;
  - `RENDERER_VERSION`;
  - the model files' SHA-256s;
  - the versions of kokoro-onnx, onnxruntime, espeakng-loader, phonemizer, numpy, and scipy.

  The script's title and expectations aren't in it. A script whose WAV exists isn't rendered again, and then the model isn't loaded at all.
- The model files are pinned in `lab/scripts/kokoro_files.json`. These are the files kokoro-onnx 0.6.1's README names, from release `model-files-v1.1`:

  | File | Size | SHA-256 |
  |---|---|---|
  | `kokoro-v1.0.onnx` | 325,505,369 bytes | `beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a` |
  | `voices-v1.0.bin` | 28,214,398 bytes | `bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d` |

  The sizes and hashes are GitHub's published asset digests. The renderer downloads a file only when it needs one, checks its size and SHA-256 before anything reads it, and retries network errors but never a mismatch.
- No apt package is needed: kokoro-onnx phonemizes through espeakng-loader, whose manylinux wheel bundles libespeak-ng.
- numpy and scipy are also in the lab's `dev` group, so the renderer's pytest suite runs in the checks job. It uses stand-in voices and `file://` downloads and never fetches weights.
- A committed sample of `timing.json` and `manifest.json` is checked in both languages: pytest checks the renderer writes it byte for byte, and Vitest parses it with the `DebriefTiming` and `RenderManifest` schemas.

### CI

- The composite action `.github/actions/eval-wavs` holds two `actions/cache` entries:
  - **The WAVs.** The key is a `hashFiles` of the scripts, the renderer, the model pins, and the lockfile. `restore-keys` falls back to the newest older entry, and the per-WAV hashes decide what to render again.
  - **The model files**, keyed on their pins.

  On a miss, it runs `uv sync --project lab --group tts` and renders with `--prune`. Its outputs are the WAV directory, the manifest, and whether the cache hit.
- The `eval-render` workflow runs the action. It's `workflow_dispatch` only, so it never touches a required job, and it can upload the WAVs as an artifact.
- Every Action is pinned to a full commit SHA.

### Cost policy

- **CI costs $0.**
  - `eval-render` has no secrets and calls no provider.
  - The eval job will use the fake speech-to-text adapter and these cassettes. A cassette `fetch` throws on any request it can't answer, rather than reaching the network.
  - A test checks that the cassettes hold nothing key-shaped.
- **Live runs are gated.** Only `eval-live` uses live keys:
  - it's off unless `EVAL_LIVE_ENABLED` is `true`;
  - its secrets are scoped to the `eval-live` environment;
  - a budget guard refuses to start above `EVAL_LIVE_BUDGET_USD`;
  - traces, video, and HAR are off;
  - its recorded cassettes are saved as artifacts, to review before committing.

## Consequences

**Good**

- The ground truth is reviewable and deterministic, and its dates, amounts, quotes, and targets are checked by machine.
- CI never spends anything. The WAVs never enter git, and editing one script re-renders one WAV.
- The cassettes come from the real adapters, so a change to the prompt, the schema, or the request options shows up as cassette drift.

**Bad**

- Thirty hand-written scripts are labor, and some of their judgments can't be machine-checked. For example, whether "nothing changes there" should yield no proposal.
- The cassettes bind an e2e session to a fixed entity list and call time. If `rankEntities` changes, or the e2e run doesn't pin the call time, requests miss and `CassetteMissError` says so.
- Kokoro's output can drift across onnxruntime versions and CPUs. The hash covers package versions but not CPUs, and the tests never compare audio bytes.
- Synthetic speech is easier than a rep in a car. Phase 8's consented recordings are the counterweight.

## More information

- Phase 3 build spec, WP11. Research notes: `capture_llm_eval.md` §5 (local TTS) and §6 (Chrome's fake microphone).
- Left for the second half:
  - the `capture-eval` Playwright project and the smoke test;
  - `apps/edge/src/e2e.ts` with the cassette extractor, the eval and `ui` job wiring, and the baselines;
  - `eval-live` and its budget guard.
- To check on the first `eval-render` run:
  - how fast Kokoro renders on the runners;
  - that phonemization works without apt;
  - that onnxruntime 1.32.0 runs the `model-files-v1.1` export.
