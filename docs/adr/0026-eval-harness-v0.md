# ADR-0026: Eval harness v0: synthetic debrief scripts, Kokoro rendered in CI, Chrome's fake microphone, cassettes, and $0 CI

## Status

Accepted (2026-11-19). The first half of WP11 built the scripts, the renderer, the CI render and cache step, and the cassettes. The second half built the fake-microphone Playwright projects and the smoke test, the `ui` and `eval` wiring, the report and baselines, and the live workflow. What only CI's first runs on Kokoro WAVs can confirm is listed under More information. Extended for Phase 4 (2026-11-20) by ADR-0031, harness v1; see "Amendment: Phase 4" below.

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
- `ci`'s required `ui` job and the `eval` workflow call the same action before they play the WAVs.
- Every Action is pinned to a full commit SHA.

### The fake-microphone eval

- Two Playwright projects in `apps/web`, both on the zero-setup `next dev` and the e2e edge Worker (`wrangler dev src/e2e.ts`) that the `capture` project already starts:
  - `capture-smoke` (`e2e/eval/capture-smoke.spec.ts`) plays d001's first turn. It checks that an `AnalyserNode` on the captured track measures a non-zero RMS, that PCM reached the fake speech-to-text adapter, and that the adapter heard the whole line.
  - `capture-eval` (`e2e/eval/capture-eval.spec.ts`) depends on it, so it doesn't run when the smoke test fails. It has one test per script.
- **One browser per WAV.** Chrome's fake microphone file is fixed at launch: `--use-file-for-fake-audio-capture=<abs>.wav%noloop`, with `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`. The default headless shell plays it. `EARSHOT_EVAL_CHANNEL=chromium` switches to new headless, should a runner need it (spec §8).
- **The WAV's clock.** Chrome starts the file when getUserMedia opens it. Locally, over all 30 scripts, the first turn's speech reached the page between 27 ms before and 90 ms after timing.json's offset (median 68 ms), counting from getUserMedia's resolution. An init script wraps getUserMedia to note that moment. It also hangs an `AnalyserNode` on the track, for the RMS and the speech onset, and reads the track's settings.
- **Each run:**
  1. It signs up a new user in zero-setup mode and loads the demo CRM.
  2. It opens `/capture?voice=fake&script=<id>`.
  3. It clicks Start, a user gesture, so the `AudioContext` starts.
  4. It holds Space from 250 ms before each turn's `startMs` to 200 ms after its `endMs`, on that clock. A press that comes late, because the engine wasn't ready, is held as long as an on-time one, and its lateness goes in the result.
- **The session context.** `GET /v1/e2e/scenario?script=<id>` serves the script's scenario: `DEMO_SESSION_ENTITIES`, `startedAt` equal to the script's call time, and its time zone. SessionDO takes the call time from `start.startedAt`.
  - The e2e Worker answers each turn from `evalCassette(provider, scriptId)`. It finds the script by the session's call time with `debriefAt`; every script has its own call time, and a test checks it. Other sessions get the demo cassettes.
  - `withTurnFetch` picks the cassette when the turn runs, from its session context. The extractor SessionDO built, which checked the model, is rebuilt with the turn's `fetch`.
- **The fake adapter follows the WAV.** The test puts the script's timing.json on the page as `__earshotFakeTiming`. The fake voice checks that it says the scenario's lines, then feeds each turn's text, offsets, and words to the fake adapter on its `presses` timeline.
- **Results come off the session socket.** Every event SessionDO commits is sent to the client, so the test reads `turn.completed`, `proposal.created`, and `turn.measured` from the socket's frames, with no hook in the app. The same reading works against any stack, live runs included.
- **What a run must show:**
  - each turn ends as `proposals`, or as `nothing_to_propose` when it expects none;
  - each proposal, in order, has the expected type, demo CRM target id, and `KEY_FIELDS` exactly;
  - the transcript is the script's text, word for word (CI only);
  - every turn with a card has its `turn.measured`.
- **Each run records:**
  - its latency stages, from `turn.measured`: end of speech (the release) to the last final, to the first proposal, to its card's paint;
  - whether the browser's audio processing was on. The app asks for echo cancellation, noise suppression, and auto gain; Chromium advises them off for injected files, and the eval records rather than changes them;
  - the speech onset, and each press's lateness.
- **The report.** A Playwright reporter writes each run's results as one report: p50 and p95 (nearest rank, always a measured value), max, and a row per script. `pnpm --filter @earshot/evals eval:report` merges shards' reports, writes the Markdown to the job summary, and compares it with the baseline.
- **Baselines are written on purpose.** `pnpm --filter @earshot/evals baseline:update <report.json>` writes `packages/evals/baselines/ci.json`. It takes only a whole run, all 30 scripts as scripted, on Kokoro WAVs. `--live` writes `baselines/live-<date>.json`, per provider pair. CI never writes either. The CI numbers come from `next dev` with fakes, so they track the pipeline's own overhead (G1a), not what a rep feels (G1b).
- **`--stub`** (`render_debriefs.py --stub`) is **not for evaluation.** It renders a tone per word where timing.json puts the word, so the plumbing can be checked without the model. Stub renders go to `lab/.cache/wavs-stub`, never into Kokoro's directory. Their manifest names the pseudo model file `STUB-TONES-NOT-FOR-EVALUATION`, which CI's eval and both baselines refuse.

### Where it runs

| Where | What | When |
|---|---|---|
| `ci` › `ui` (required, 30 min) | The smoke test, then d001, d010, d016, d025, d030 | Every PR, and pushes to main |
| `eval` | The smoke test and all 30, in 4 shards of one browser at a time, then a job that merges the reports. Its `--check` fails unless every script ran and passed. | PRs that touch the voice, agent, core, edge, capture, or eval code, the WAV inputs, the lockfile, or the workflow (a `changes` job decides, so a required `eval` check passes when skipped); nightly on main; by hand |
| `eval-live` | All 30 on real providers, per pair | Only when `EVAL_LIVE_ENABLED` is `true`: nightly, or by hand |

### Cost policy

- **CI costs $0.**
  - `eval-render` has no secrets and calls no provider.
  - The eval job will use the fake speech-to-text adapter and these cassettes. A cassette `fetch` throws on any request it can't answer, rather than reaching the network.
  - A test checks that the cassettes hold nothing key-shaped.
- **Live runs are gated.** Only `eval-live` uses live keys:
  - it's off unless `EVAL_LIVE_ENABLED` is `true`, and never runs on pull requests;
  - its secrets (`EVAL_ASSEMBLYAI_KEY`, `EVAL_DEEPGRAM_KEY`, `EVAL_ANTHROPIC_KEY`, `EVAL_GROQ_KEY`) are scoped to the `eval-live` environment;
  - a budget guard (`pnpm --filter @earshot/evals eval:budget`) refuses to start above `EVAL_LIVE_BUDGET_USD`, default $1.00. It prices each fixture on each pair from the price table: socket time is the WAV plus 25 s, and each turn is 4,000 input and 400 output tokens, against the cassettes' 3,600 and 90 to 140. Then it adds a quarter. All 30 scripts on the four pairs come to about $0.90 on stub-length audio (13 minutes), inside the default; Kokoro's real durations decide;
  - traces, video, screenshots, and HAR are off, since a key is typed into Settings → Keys;
  - sessions on AssemblyAI open at most 5 new streams a minute, its free tier's limit;
  - the page's clock is pinned to the script's call time (`page.clock.setFixedTime`) and its time zone, so the expected dates still hold;
  - the report and a draft `live-<date>.json` are saved as artifacts, to review before committing.

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

## Amendment: Phase 4 (2026-11-20)

Harness v1 (ADR-0031) builds on this harness rather than replacing it:

- **Debrief format v2.** Each turn carries what both witnesses heard (`heard.biased`, `heard.unbiased`). Targets become `{ id, decision }`, with optional `expectFlags`, the `meeting` type, and per-script `noise`. The 30 files here stay format v1 on disk and are upgraded in code, so their WAVs and cassettes don't move.
- **170 more scripts** come from a seeded grammar, in `debriefs/generated/`. The renderer and the WAV cache key still read only `debriefs/*.json`, so the fake-microphone eval still renders and plays exactly these 30. Swapping them for a stratified 30 of the 200 needs the changes ADR-0031 lists.
- **Noise.** The renderer can mix car, street, or cafe noise under a script's speech at its SNR (Phase 4 WP10b). The noise spec joins a WAV's hash only when the script has one, so the 30 WAVs' hashes are unchanged.
- **New gates.** `eval:understanding --check` runs all 200 debriefs through offline cassettes with seeded model-like errors, and `eval:linking --check` runs the confusable-name set; both run in `checks`. The live smoke eval is a new opt-in tier, and the fake-microphone eval and `eval-live` here are unchanged.

## More information

- Phase 3 build spec, WP11. Research notes: `capture_llm_eval.md` §5 (local TTS) and §6 (Chrome's fake microphone).
- To check on the first `ui` and `eval` runs on Kokoro WAVs:
  - that the headless shell plays the file on GitHub's runners (locally it does, on macOS; spec §8);
  - that the first turn's speech arrives within about 100 ms of timing.json's offset, as it does locally;
  - that noise suppression and auto gain don't stop Kokoro's speech registering on the `AnalyserNode`;
  - the shards' wall time, and the baseline. `baselines/ci.json` is recorded from the first green `eval` run's `eval-report` artifact, not from local stub runs.
- Not built yet:
  - saving the live run's raw provider responses as cassettes, which needs a recording entry on the edge Worker;
  - running `eval-live` against a production build, which needs a deployed stack (spec §6). Until then it runs `next dev` with the production edge entry.
- To check on the first `eval-render` run:
  - how fast Kokoro renders on the runners;
  - that phonemization works without apt;
  - that onnxruntime 1.32.0 runs the `model-files-v1.1` export.
