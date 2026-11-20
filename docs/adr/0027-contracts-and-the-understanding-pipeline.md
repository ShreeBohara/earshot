# ADR-0027: Contracts and the understanding pipeline: proposals name the record, a deterministic linker resolves it, and the second witness can downgrade it

## Status

Accepted (2026-11-20). Phase 4 WP1 built the contracts below: proposal schema v2 with its upcaster, two new event types, the protocol additions, and migration 0012. WP8 (2026-11-20) built the pipeline: tool schema v2, prompt v2, `understand()`, and `SessionDO` writing `proposal.created` v2, with the web app sending the open account and each record's parent. The second witness's message and comparison in `SessionDO` are WP9's, which built them on 2026-11-20 (ADR-0029). Amends ADR-0020 (see its "Phase 4 event types") and ADR-0025 (no CRM list, tool schema v2).

## Context and problem

In Phase 3 the extractor sees the session's CRM list and names a target by id, and only exact names and aliases match. Phase 4 changes who decides (spec decision 1). The model quotes the words that named a record and says what kind of record it is, and a deterministic linker in `SessionDO` resolves the quote against the session's records by sound, spelling, and context. A second witness, an unbiased transcript of the same turn, can then disagree with the biased one at a name. The contracts must carry all of this:

- a target that records the decision (link, ask, new, or none), its probability, its candidates, and the words that named it;
- flags and conflicts that arrive after the card has appeared, without holding the card back for the second witness;
- each record's parent and the account open in Earshot, as context for the linker;
- the browser's unbiased transcript of each turn.

Every stored Phase 3 event has to keep loading (ADR-0020). The client and the edge deploy together, edge first, so the protocol can grow without a version bump.

## Considered options

- Proposal shape: **a new version of `proposal.created` with an upcaster from v1**; editing v1 in place; v1 plus a separate `proposal.linked` event.
- Later changes to a proposal: **a `proposal.flagged` event that adds flags, a conflict, and an optional downgrade**; writing the proposal again; waiting for both witnesses before writing any proposal.
- The protocol: **optional fields and one new client message, still protocol version 1**; protocol version 2.
- Storage: **`proposals.target` and `proposals.conflicts` as `jsonb` columns**; normalized candidate and conflict tables.

## Decision

### Events

**`proposal.created` v2** replaces `targetEntityId` with `target`: `decision` (`linked`, `ask`, `new`, or `none`), `entityId` (set exactly when linked), the model's `kind`, the `basis` of a link (`exact`, `sound`, `context`, or `focus`), the calibrated probability `p`, the `mention` and `company` quotes with their evidence, and up to four `candidates` (three records plus "new", a `null` id). It adds the `meeting` type, seven risk kinds, a `norm` object on each field (the model's value when a deterministic reading replaced it, every reading of an ambiguous quote, a currency), `supersedes` for WP14, and the `linker` version. A flag on the target uses the reserved field name `target`.

**The v1 → v2 upcaster.** A `targetEntityId` becomes `linked` on an `exact` basis, since v1 matched only exact names and aliases. No target becomes `new` when v1 flagged `new_entity`, and `none` otherwise. What v1 never recorded is null or empty, fields and flags carry over unchanged, and `supersedes` and `linker` are null. v1's exports stay frozen.

**`proposal.flagged` v1** (written by `SessionDO` after comparing the witnesses): the proposal, the source (`witness`), at least one flag, an optional downgrade (`{ decision: "ask", candidates }`, at least one candidate), and an optional conflict (the field, the biased quote with its evidence, and the unbiased words with their utterance and audio window).

**`turn.witnessed` v1:** how a turn's second witness ended (`compared`, `failed`, or `skipped`), its provider and model, the unbiased utterances, the number of conflicts, the latency, and why there was no comparison.

### Projections

- `proposalsProjection` folds v2 targets. `targetEntityId` stays on the view and always equals `target.entityId`.
- `proposal.flagged` adds each flag the proposal doesn't already have (the same kind on the same field), and appends its conflict.
- A downgrade sets the decision to "ask", clears `entityId`, and keeps the old target first among the candidates: the linked record, or "new" for a new one. The downgrade must list that record with the probability the comparison gave it. If it doesn't, the fold fails with a `ProjectionError` rather than invent a probability. A target that was already "ask" or "none" takes the downgrade's candidates as they are.
- `sessionProjection` treats `turn.witnessed` and `proposal.flagged` like `turn.completed`: they move only `lastSeq` and `lastEventAt`. Unbiased utterances already land in `utterancesProjection` with `witness: "unbiased"`.

### The protocol (still version 1)

- `EntityRef` gains an optional `parentId`: the company of a contact or deal. It's an exported contract, so JSON Schema and Pydantic have it too.
- The socket caps `parentId` at 128 characters, like `id`.
- `start` gains an optional `focusEntityId`, at most 128 characters, which must be one of `start.entities`.
- A new client message, `witness`, carries one turn's unbiased transcript. It names the provider and model, and its outcome is either `transcribed`, with an utterance whose witness must be `unbiased`, or `failed`/`skipped`, with a reason. An optional `latencyMs` is in whole ms.
- Like every client message, `witness` is held to the 64 KiB frame cap and the 4,000-character text cap, and refused if it holds anything key-shaped. The audio and the witness's provider key go from the browser straight to the provider, never through Earshot.
- The `utterance` message is unchanged. Extraction must still leave unbiased utterances out (WP8).

### Storage

- Migration 0012 adds `proposals.target jsonb`, null on older rows until their session is rebuilt, and `proposals.conflicts jsonb not null default '[]'`.
- `target_entity_id` holds `target.entityId`, still null when the entity isn't in the workspace's CRM mirror.
- The `target` column keeps the decision as the events have it.
- Flags on the target go into `risk_flags` as `kind:target`.

### Writers

From WP8, `SessionDO` writes `proposal.created` v2, and so does the in-memory fake in `@earshot/voice/testing`. Readers still upcast every stored v1 event, so Phase 3's sessions, the replay demo, and Postgres's older rows read as v2.

### Rules the schema doesn't check

Three cross-field rules have no JSON Schema form short of a union, which would change the contract's shape in both languages. The writer (`understand()`, WP8) keeps them, and tests in WP4, WP5, and WP8 cover them:

- `entityId` is set exactly when the decision is "linked";
- `mention` is null only for an implied target or "none";
- no proposal has a field named `target`.

### The pipeline (WP8)

`turn_end` runs one forced tool call with no CRM list. `runTurn` (`@earshot/agent`) then understands the drafts, and returns `proposal.created` v2 payloads, the turn's usage, and the session's earlier links once this turn's are added.

**Tool schema v2** (`packages/agent/src/schema.ts`). Each proposal's `target` is `{ quote, kind, company: { quote } | null } | null`: the words that named the record, exactly as transcribed; the kind they name (`company`, `contact`, or `deal`); and the company said with a contact or a deal. A contact proposal has no `target`: its record is the person its `name` field names, with its `company` field as context. The `meeting` type is new: `title`, `date` (YYYY-MM-DD), `time` (HH:MM, 24-hour), and `attendees`, each quoted. The JSON Schema still meets Anthropic's strict rules and Groq's (types, enums, and nullability only); time formats and the quotes' 200-character cap are checked in the refinement, like dates.

**Prompt v2** (`prompt.ts`). No CRM list, which was about 1,600 of a turn's 3,600 input tokens. One line names the open account (`Open account: Acme Dynamics`), when there is one. New rules: quote names exactly as transcribed and never correct a spelling; give a deal's company as said, even inside the deal's name ("the Acme renewal" has the company "Acme"); if the rep doesn't name the record in this turn, set `target` to null (and don't fill it in from the open account); a contact has no target. Phase 3's rules stay: this turn's transcript only, negations kept, dates resolved against the call time. Line breaks are joined by splitting and trimming rather than with `\s*[\r\n]+\s*`, which backtracks quadratically on a long run of spaces.

**`understand(draft, ctx)`** (`understand.ts`, replacing `attach.ts`), pure, with the session's link index, open account, earlier links, and the linker's frozen parameters:

1. **Evidence.** Every quote (each field's, the target's, and its company's) is located in the turn's biased utterances, as Phase 3 located them. A field whose quote isn't there is dropped and flagged; a proposal left with no field is dropped.
2. **Link** (ADR-0028), with the kinds the proposal type allows and the turn's other named records as companies said in the turn.
3. and 4. **Normalize and check** each field (`checkField`, ADR-0030), a meeting's time against its date. A unique reading replaces a value that disagrees, kept in `norm.llmValue`.

Spec §4.3's rules, as built:

- **An unquoted target** (its words aren't in the transcript) is `none`, with `kind` as the model gave it, no mention, and `unsupported` on the target. It's never linked.
- **An implied target**: no record named and an account open. The target is the account (`linked`, `basis: "focus"`, `p` null, no mention or candidates), flagged `implied_target`. A deal update can't target a company, so it takes the open account's only deal. With no deal or several it has no target: a question would need probabilities the linker never computed, so Phase 5 asks the rep instead. With no account open, an unnamed record is `none`, unflagged.
- **Contact proposals** link on the `name` field's words, with the `company` field's as the linker's company context.
- **Deals named by their company** resolve to the company's only deal, on the linker's `context` basis; with several, it asks.
- **A deal's company said apart from the rest** ("Pier Logistics … the expansion") is read by the linker as the two together, company first. Linker v1 was fit on deal mentions in that spoken form ("Pier expansion") with no separate company: none of `confusable.v1`'s 98 deal items has one. So a deal's company is never passed on the side, where `parentCtx` would weigh it out of its training distribution; it's folded into the words, unless they already hold it. The target keeps both quotes and the company's own link.
- **Flags on the target** (`field: "target"`): `ambiguous_target` for an ask, `new_entity` for a new record, `link_uncertain` for a link that isn't exact with p below 0.97, `implied_target`, and `unsupported`. `target.company.entityId` is the company's own link when it links, else null.
- **Earlier links.** Each turn's targets linked from words that were said, and each company linked beside them, join the session's earlier links, most recent first, at most 20. An implied target doesn't: nothing named it. Within a turn, each proposal sees the links the proposals before it made.
- **Unbiased utterances** never reach extraction: `SessionDO` and `runTurn` both keep only the biased witness's.

**`SessionDO`** stores `focus_entity_id` (from `start`) and `link_recent` (the JSON list above, written in the turn's transaction) in `meta`. It builds the link index from the stored entities on the first turn after each wake, never at `start`, since the constructor runs again after every hibernation. The turn's log line counts the decisions (linked, ask, new, none) and holds no names.

**The web app.** `POST /api/sessions` answers with `focusEntityId`: the request's `selectedAccountId` when it's a company among the session's entities (`start` refuses any other), else null. Each contact and deal carries `parentId`: the `crm_entities.id` of the company on the same connection whose source id is its `properties.companyId`. The client sends both in `start`; the capture screen's fake mode takes them from the e2e scenario, whose cassettes were recorded with them.

### What `unsupported` means

One thing, in every version and place: the words the model cited don't back what it wrote.

- On a field whose quote isn't in the turn's transcript: the field is dropped, and the flag names it. This is Phase 3's only use.
- On a date, time, or amount whose quote holds no reading of that kind: the value is kept, flagged (the faithfulness check's "unread", ADR-0030).
- On the target (`unsupported:target`): the record's name isn't in the transcript, so nothing is linked and the decision is `none`.

The contract (`RiskKindV2`'s documentation), the pipeline, and the copy (`RISK_LABELS`, which the tray and the `/demo` page share: "Not backed by what was said", and on the target "Record's name not in the transcript") say the same.

### The 30 scripts under v2 (names as said)

Phase 3's scripts named each target by id, and the cassettes drafted the target by its exact CRM name. Under v2 the cassettes draft what a model that never saw the list would write, so the ground truth gained three optional fields, with no format version bump:

- **`focusEntityId` per script:** the account the debrief is about, in 28 of the 30; d027 and d029 run with none.
- **`named` per proposal:** the words that named its record, its kind, and the company said with it. Absent for a contact, whose record is its `name`.
- **`decision` per proposal:** set only where the linker should ask (below); otherwise it's the plain reading of `target`.

**Names are written as said.** Three Phase 3 values expanded a company past the rep's words ("Akme Dynamics" where the rep said "Akme"; "Sigma Tooling"; "Verdant Agritech" as a counterpart), which only a model that saw the list could write. WP8 fixed the ground truth rather than score names through the linked target: the values are now "Akme", "Sigma", and "Verdant". The linker resolves the company, and the eval scores the target by the linker's decision. A test holds every name field in the scripts equal to its quote once normalized.

**What linker v1 decides** on the scripts' 100 proposals, through both adapters' cassettes: 96 as written (91 linked, 5 new contacts) and 4 asks, each offering the scripted record:

- **d008 turn 2,** "Blue Harbor site rollout": a deal named with a word dropped from its company ("Blue Harbor" for Blue Harbor Analytics), p 0.71 against τ_link's 0.72. `confusable.v1`'s deal mentions only ever drop words from the end.
- **d009 turn 3, d026 turns 1 and 2:** a company named while its own deal is in play ("Summit Ridge Medical" after its starter plan was linked; "Granite State Builders" beside, and "Granite" after, its analytics add-on). The company and the deal named by the company both score near 1, and the linker's normalization splits them about 50/50. The model's kind ("company") is a feature, not a filter (spec §4.4), so it doesn't settle them.

Each is a safe outcome, a question rather than a wrong account, and each is input for linker v2 (WP10's 200 debriefs measure how often they happen). The scripts record them as `decision: "ask"`, since the fake-microphone eval checks each turn's decision exactly.

### Measurements (WP8)

- **Speed** (this Mac, Node 26, the 30 scripts' 118 turns, 5 rounds): the link index builds in about 7 ms, once per wake; the first, cold turn takes about 4 ms; warm turns take 0.24 ms at the median and 0.82 ms at p95, against the understanding step's 20 ms p95 target.
- **Flags:** 41 of the 100 proposals carry one: `link_uncertain` 27 (links by context below p 0.97, most of them at 0.93, mostly contacts and homophone companies the open account settles), `negation` 6, `new_entity` 5, `ambiguous_target` 4. That's above the 35% guard WP10 will report; `link_uncertain` on context links is what to look at first.
- **Bundle:** the edge Worker's dry-run bundle grows from 2,491 KiB to 2,713 KiB (gzip 464 to 511 KiB): +222 KiB, +48 KiB gzipped, for chrono-node's English parser, double-metaphone, the linker with its parameters, the normalizers, and the faithfulness check. A workerd test runs chrono-node and double-metaphone through `runTurn`. Startup time is measured on the first deploy.
- **Tokens:** the eval cassettes' input estimate falls from about 3,600 to about 2,000 tokens a turn with the list gone (an estimate, not a measurement; the live smoke eval measures it).
- **End to end:** the fake-microphone eval, run locally on `--stub` WAVs (tones, so not an evaluation), passed all 30 scripts and 118 of 118 turns as scripted, through the capture screen, the e2e Worker's `SessionDO`, and the cassettes. On this Mac, end of speech to card painted took 46 ms at the median and 63 ms at p95, and last final to proposal 11 and 24 ms. The Kokoro run, and the overhead baseline it records (`baselines/ci.json`, not committed yet), are CI's `eval` job's.

## Consequences

**Good**

- The model can no longer choose a CRM record, so a misheard name and the model's guess can't line up, and prompt injection loses its target: linking is deterministic and testable at $0.
- A turn that names no record still lands on the open account, visibly flagged.

- Every Phase 3 session still loads: `demo-session.jsonl` is byte-for-byte unchanged and replays to v2 targets.
- The decision, its evidence, and its candidates are data, so a card can show "Ask: Acme Dynamics or Akme Dynamics?" and an eval can score it at $0.
- A conflict reaches the card after it appears, so the witness never delays the first card.
- Old clients and the new edge speak the same protocol version.

**Bad**

- Projections now fail on a downgrade that leaves out the target it replaces. That's a bug in the comparison, but it stops the session's replay until fixed with a new event or an upcaster.
- `targetEntityId` and `target.entityId` duplicate each other on the view and in the table.
- `supersedes` and `linker` live only in the events. The `proposals` table has no columns for them yet.
- The three cross-field rules aren't enforced by the schema in either language.
- Linker v1 asks on phrasings its set never had: a word dropped from a deal's company, and a company named while its own deal is in play (4 of the scripts' 100 targets).
- `link_uncertain` flags most context links, which pushes the scripts' flag rate to 41%.
- Folding a deal's company into its words is a product-side reading the confusable set doesn't measure. It matches the set's spoken form, but WP10's generated debriefs are where it's scored.

## More information

- Spec: `reports/Earshot Phase 4 build spec.md`, §4.1 to §4.3, WP1, and WP8.
- Pipeline: `packages/agent/src/{schema,prompt,understand,turn}.ts`; `apps/edge/src/session-do.ts`; `apps/web/lib/voice/{routes,entities,keyterms}.ts`; the tray's copy in `apps/web/lib/capture/copy.ts`.
- Ground truth: `packages/evals/debriefs/` (`focusEntityId`, `named`, `decision`), `packages/evals/src/{schema,generate,check,session}.ts`; regenerate the cassettes with `pnpm --filter @earshot/agent cassettes:gen` and `pnpm --filter @earshot/evals cassettes:gen`.
- Contracts: `packages/core/src/contracts/events/{proposal-created,proposal-flagged,turn-witnessed}.ts`, `entity-ref.ts`, and `session-protocol.ts`.
- Upcaster and projections: `packages/events/src/{upcasters,projections/proposals}.ts`.
- Storage: `packages/db/migrations/0012_proposal_targets.sql` and `packages/db/src/projections.ts`.
- Regenerate the demo snapshot on purpose with `pnpm --filter @earshot/events test -u`. WP1's run added each proposal's upcast `target` and an empty `conflicts`, and nothing else.
