# ADR-0037: The recap: quote and verify on both providers, lenses as configuration, follow-up drafts deferred

## Status

Proposed (2026-11-20). Phase 5 WP10 built it (below): `recap.created` v1 and `end.recap`, `@earshot/agent/recap` (the forced `submit_recap` call, the checks in code, and the three lens files), `SessionDO` writing the recap between `session.ended` and the seal, migration 0015's `sessions.recap`, the recap in the inbox and on the capture screen, `eval:recap --check` in `checks` on cassettes for all 200 debriefs, and the recap in the live smoke eval. The live check (one recap on each provider, under $0.01) is built as `recap:live` and waits for the user's approval; it answers Appendix B's question 7. ADR-0025 is amended for the recap's call.

## Context and problem

After a debrief the rep wants it in a few lines: what happened, what's next, and who promised what (Phase 5 decision 12). Those lines go wherever the rep's notes go, so they mustn't say anything the rep didn't. A recap that adds "they'll sign by Monday" is worse than none.

What the recap has to work within:

- **Both providers.** A session runs on Claude Haiku 5.5 or Groq's gpt-oss-20b, on the user's own key (ADR-0009, ADR-0025). The recap uses the session's provider, not a third one.
- **Keys per request.** A key rides on the message that needs it and is used once (ADR-0021). `SessionDO` keeps none, and the socket refuses a key-shaped string anywhere but where the protocol puts one.
- **Evidence has one shape.** Every field on a card carries `Evidence`: an utterance, a character span, an audio window, a confidence. WP9 plays a span's audio (ADR-0036). A recap's sentence should carry the same, so it can be checked the same way.
- **The seal.** `SessionDO` seals a session 60 s after the rep's last tray action, at most 30 minutes after the end (ADR-0032). The recap belongs in the log before the seal, and mustn't hold the tray, or the seal, for long.
- **$0 in CI.** Every gate runs on cassettes (ADR-0031).
- **Methodology lenses.** Many sales teams check a deal against MEDDIC, SPICED, or BANT. A lens is a list of fields, and it mustn't become a place for invention either.

## Considered options

- **Backing each sentence:** **quote and verify: the model quotes the rep's words for each sentence, and code locates every quote in the transcript and drops a sentence with none (chosen)**; Anthropic's citations (Anthropic-only; a 400 with structured output, so the sections would be parsed from text; no promise of a citation per line, so code checks anyway; block or character indices instead of `Evidence`; about $0.0001 a recap saved), kept as a possible Anthropic-only mode for Phase 8's E8; Groq's `documents` and `citation_options` (the shape and the models are undocumented); no backing.
- **Where it runs:** **`SessionDO`, right after `session.ended`, in the serial queue, on a key `end` carries (chosen)**; the browser (a second path per provider, and a tab closed after the end loses the recap); a Queue consumer (the key would have to leave `SessionDO`'s memory).
- **The call:** **one forced `submit_recap`, through the extraction adapters (chosen)**; free text, then parsing; Groq's strict structured output (no tools with it, so a second path on one provider).
- **A sentence that cites words without restating them:** **kept, marked `weakSupport`, shown with a note (chosen)**; dropped (a recap restates, so a paraphrase the words back would go too); unmarked.
- **Lenses:** **a JSON file per lens, its fields each with a line for the model, chosen per device and sent with `end` (chosen)**; code per lens; a workspace setting (none exists yet, and the spec puts it per device).
- **Failure:** **every ended session gets exactly one `recap.created`, whose outcome is `created`, `failed`, or `skipped`, with a reason (chosen)**; nothing on failure (the inbox couldn't tell "not yet" from "never").
- **The deadline:** **15 s from the call's start, two attempts at most (chosen, spec §4.10)**; the turn's 8 s (a recap's answer is longer); none (the seal would wait on a provider).
- **Follow-up drafts:** **deferred to Phase 7, beside briefs (chosen)**: an email body has no words of the rep's to quote, so it can't meet the recap's rule.

## Decision

### The contracts (`packages/core`, `packages/events`, `packages/db`)

- **`recap.created` v1** (spec §4.9): `recapId`; `outcome` (`created`, `failed`, `skipped`); `reason` (`no_key`, `no_speech`, `invalid_output`, `rate_limited`, `provider_error`, `timeout`, or null); `llm` (`{ provider, model }` or null); at most 12 `sentences`, each `{ kind, text, evidence, weakSupport }` with `kind` one of `headline`, `next_step`, `commitment`, `text` up to 400 characters, and 1–4 pieces of `Evidence`; `dropped`; and `lens`, `{ id, fields }` or null, its 1–8 fields each `{ field, quote, evidence }` with both null for "not mentioned". The schema is structural, with no refinements, so it exports to JSON Schema and Pydantic; parity fixtures run in Vitest and pytest.
- **The writer's rules** are the projection's: `sessionProjection` folds one recap, after `session.ended` and before `session.sealed`, and refuses one that breaks them (`recapProblem`): a created recap has no reason; a failed or skipped one says why and holds nothing; `skipped` means no key or no speech, and every other reason is `failed`; one headline at most, first; a lens names each field once, with a quote and its evidence or neither.
- **`end.recap`:** `{ llm: { provider, model }, key, lens? }`. **The key guard** now allows a key-shaped string in exactly two places, `turn_end.key` and `end.recap.key`; anywhere else, elsewhere in `end` included, the message is refused (`stray_key`) without quoting it.
- **Migration 0015** adds `sessions.recap jsonb`, which `rebuildProjections` fills from the session's projection.

### The call (`@earshot/agent/recap`)

- **The tool:** `submit_recap`, input `{ sentences: [{ kind, text, quotes }], lens: { fields: [{ field, quote }] } | null }`, within Anthropic's strict rules and Groq's, like `submit_proposals`. Zod checks 1–12 sentences, at least one headline, non-empty text up to 400 characters, and 1–4 quotes of up to 200. A failure gets one more call with the problems listed; a second is `invalid_output`.
- **The prompt:** instructions of about 600 tokens; the session's biased transcript (the unbiased witness's text left out); its proposals as context only, rejected and superseded ones left out, records by name; the lens's fields and what each means; and the rule that every sentence quotes the rep's exact words and adds nothing the rep didn't say.
- **The adapters:** the extractor's, unchanged (ADR-0025): the provider built per call from the key and dropped after, Anthropic strict with one tool call, Groq at low reasoning. Output caps of 2,048 tokens on Anthropic and 4,096 on Groq, whose reasoning counts. No prompt cache: one recap per session can't reuse a 5-minute cache.
- **`runRecap`** never throws for a provider or validation failure. It aborts at the 15 s deadline, tries a retryable failure (a 429, a 5xx, a dropped connection) once more within it, after `Retry-After` or a backoff, and otherwise returns `failed` with its reason: `invalid_output`, `rate_limited`, `timeout`, or `provider_error` (a rejected key, a refusal, anything else). No speech is `skipped`, `no_speech`, with no call. Its usage is priced from the same table as a turn's and recorded as `usage.recorded`.

### The checks, in code (`checks.ts`)

1. Every quote is located with `locateQuote` and `evidenceFor` in the session's biased utterances, as a field's is.
2. A sentence keeps the quotes that were found, at most 4 and each span once, and is dropped if none were. `dropped` counts them.
3. `weakSupport` marks a sentence whose content words overlap its located quotes under 0.5 (target), the faithfulness check's measure and threshold (ADR-0030).
4. Only the first kept headline is kept, and it comes first.
5. A lens field whose quote isn't found is "not mentioned", as one the model left null is. Every field of the lens comes back, in the file's order.
6. A sentence shaped like a provider key is dropped too, and counted: no utterance can hold one, and the client refuses a server message carrying one.

### Lenses (`packages/agent/src/recap/lenses/*.json`)

Each file is `{ id, label, fields: [{ id, label, describe }] }`: MEDDIC (metrics, economic buyer, decision criteria, decision process, identified pain, champion), SPICED (situation, pain, impact, critical event, decision), BANT (budget, authority, need, timeline). A test holds the files to their shape. Settings → Capture's "Recap lens" (None by default, then MEDDIC, SPICED, BANT) is per device (`earshot.capture.recap-lens`), and the choice travels with `end`. The web app imports only the lens files (`@earshot/agent/recap/lenses`), never the AI SDK.

### `SessionDO`

- **After `session.ended`, in the same turn of the serial queue:** the recap, then `recap.created` and its `usage.recorded` in one transaction, then a flush. `session.ended` sets `recap_due`, so every session it ends owes one recap. The ack to `end` goes out with `session.ended`: the client never waits for the recap.
- **Without a request** (no key on the device, or the idle alarm ended the session), the recap is `skipped`, `no_key`. A model with no adapter or price, or an AI Gateway id that can't be part of a URL, is `failed`, `provider_error`, with `llm` null; the end itself is never refused.
- **The key** lives in the call's closure, is used for that call, and is never stored or logged. The log says "recap recorded" with counts and codes only: outcome, reason, sentences, dropped, weak, lens, mentioned.
- **The tray and the seal.** A review doesn't go through the serial queue, so the tray works while the recap is written. The seal does, so it comes after the recap, which ends within 15 s. If the object restarts mid-recap, the key is gone with it: the seal appends the owed recap as `failed`, `timeout`, `llm` null, just before `session.sealed`, and logs "recap lost". Every ended session has exactly one recap before its seal.

### The client (`@earshot/voice`, `apps/web`)

- `SessionClient.end(endedAt, recap?)`. The outbox, in memory only, keeps the recap's key apart from the message and puts it back into each frame until the ack, as it does a turn's.
- The capture controller asks for the recap on the session's own LLM and its turn key, with the device's lens. With no key it sends no request.

### The UI

- **Where:** at the top of its debrief's group in the inbox, under the group's header; and on the capture screen under "Debrief ended" once it arrives, with "Writing the recap from what you said…" until then.
- **A sentence** is a Base UI Collapsible's trigger. It opens the words it quotes ("Heard:" for screen readers), each with WP9's play button where this device kept the audio, and, on a weakly supported sentence, "Says more than these words do." A line says every sentence quotes the rep, and how many were left out and why.
- **The lens** sits in its own Collapsible, collapsed: "MEDDIC: 2 of 6 mentioned". Open, each field shows the rep's words or "Not mentioned".
- **No recap** is one line saying why, one per reason ("No recap: it didn't come back within 15 seconds.").
- **Nothing speaks on its own:** no live region is added, so the inbox's toaster and the capture screen's transcript stay the only ones. `@earshot/ui` gains `Collapsible`. Stories and Playwright check both themes with axe.

### Evals

- **Cassettes for all 200 debriefs** (`packages/evals/cassettes/recap/`), built offline from the ground truth: a headline, a next step per task, a commitment per commitment, each quoting the script's own words, and the lens by rotation (none, MEDDIC, SPICED, BANT). Seeded errors, labelled in `seeded.json`: 10% of the ground truth's sentences (target) get a bad twin whose quote isn't in the transcript, invented or paraphrased, and 10% of the lens fields the rep never answered get an invented quote. `recap:gen` rebuilds them from seed `0x5be0cd19`, through the real adapters against hand-written provider answers, and a test fails if the committed files drift.
- **`eval:recap --check`,** in `checks`, replays them through `runRecap` and the checks on both providers. It fails unless 100% of kept sentences carry evidence, every seeded bad sentence was dropped, every recap has a headline, every ground-truth sentence was kept, every invented lens quote came back "not mentioned", no request missed its cassette, and the weak-support share hasn't risen more than 3 points over `baselines/recap.json` (target). On both providers: 454 of 454 kept sentences with evidence, 45 of 45 seeded bad sentences dropped (9.0% of 499 written), 200 of 200 headlines, 53 of 53 invented lens quotes not mentioned, weak support 47 of 454 (10.4%).
- **The live smoke eval** (ADR-0031): each script's recap on the live model after its turns, through the same pacer and budget meter, on the same request as its cassette (the ground truth's proposals as context), so an offline run replays the recap cassettes. It's gated on 100% recap evidence and on the drop rate against the baseline's median, by max(5 points, 2 × the spread) (target). The estimate and the in-run guard include the recaps, never cached: Haiku 5.5's run rises from about $0.030 to $0.045 with the cache; gpt-oss-20b's from about $0.102 to $0.117, over the $0.10 default budget, so a Groq run needs a budget set. The baseline file's format is 2.
- **The live check** (`recap:live`, `src/recap/live.ts`): one recap per provider on a synthetic debrief (d002, MEDDIC), on production's recapper, prompt, checks, and 15 s policy. It prices the worst case (two writes, each with its validation retry, a quarter more: $0.0047 for d002 on both providers) and refuses a budget over $0.01, or under the estimate, before it reads the environment; then it needs `EARSHOT_RECAP_LIVE=1` and `EVAL_ANTHROPIC_KEY` and `EVAL_GROQ_KEY`. It reports numbers and fixed codes only. A $0 test drives it on the cassettes.

### Follow-up drafts

Deferred to Phase 7, beside briefs. A draft's body would be the model's words, with none of the rep's to quote.

### Beyond the spec

- The checks drop a key-shaped sentence; the gate also requires every ground-truth sentence kept and every invented lens quote "not mentioned"; the projection enforces the writer's rules; validation requires a headline, so a recap without one is retried.
- An idle end gets its recap too (`skipped`, `no_key`): every ended session has one.
- The eval and the smoke eval give the recap the ground truth's proposals as context, so an extraction mistake can't move the recap's numbers; production gives it the session's own.
- The edge's test Worker and its e2e Worker answer recaps with a scripted model that quotes the session's own words, since every such session's words differ; the edge tests also have it answer with an invented quote, invalid output, a failure, or a delay.

## Consequences

**Good**

- A recap can say only what the rep's words back, on both providers, and each sentence carries the same `Evidence` as a field, so it opens its words and plays them.
- The checks are proven at $0: every seeded bad sentence is dropped and every true one kept, on every pull request.
- Neither the tray nor the seal waits on a provider for more than 15 s, and a recap that failed is a line saying why, never a gap.
- A lens is a file: adding one is data and a label.
- About $0.0002 a recap on the cassettes' token counts, and the smoke estimate's $0.0004, against a debrief's $0.010–0.011.

**Bad**

- Real words can still be put together to mislead. `weakSupport` is a word-overlap heuristic, not entailment.
- Strict quoting drops true sentences the model paraphrased instead of quoting; `dropped` counts them, and the live drop rate is unknown until the smoke baseline is recorded.
- The quotes cost output tokens, about 100–150 a recap.
- A restart mid-recap loses it (recorded as `failed`, `timeout`): the key went with the object, so there's no retry.
- After the end, the serial queue is held up to 15 s: a witness result that arrives late waits behind the recap. The seal, 60 s after the end at the earliest, doesn't wait in practice.
- Live behavior is unverified until the live check runs: whether Haiku 5.5 makes the forced call for the recap at its default effort (Appendix B, question 7), and both models' latency against 15 s.
- **Bundle.** The edge Worker's dry-run bundle grows from 2,800.62 KiB to 2,837.86 KiB, gzip 533.26 to 543.14 KiB: +37.24 KiB, +9.88 KiB gzipped, for the recap's call, its checks, the lens files, and `SessionDO`'s handling. The web app imports only the lens files.
- The inbox shows a recap only above cards still to review: a debrief with every card reviewed, or with no proposals, has no group, so its recap shows on the capture screen only.

## More information

- Phase 5 build spec: decision 12, §4.9, §4.10, WP10, cut lines (lenses second, the recap ninth), Appendix B question 7. The tooling notes' §5 compares the three options and prices a recap.
- ADR-0025 (amended), ADR-0021, ADR-0024, ADR-0030, ADR-0031, ADR-0032, ADR-0036.
- The live check, with the user's approval: `EARSHOT_RECAP_LIVE=1 EVAL_ANTHROPIC_KEY=... EVAL_GROQ_KEY=... pnpm --filter @earshot/evals recap:live --out recap-live.json`.
