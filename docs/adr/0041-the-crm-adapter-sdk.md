# ADR-0041: The CRM adapter SDK: plan and execute, capabilities, one error taxonomy, writes that can't land twice, a reference CRM, the conformance suite, and the demo CRM as an adapter

## Status

Proposed (2026-11-25). Phase 6 WP2 built the SDK's behavior on WP1's types (ADR-0040): the error taxonomy's mapping from HTTP, retry advice, and redaction; shared planning, §4.3's table as data each adapter fills in; the dry run's renderer; `MemoryCrm`, the reference CRM, with faults by seed; the conformance suite; the demo CRM as an adapter, with its store in `@earshot/db`; and migration 0020. The outbox (WP3) runs plans and writes through it. The Twenty (WP4), HubSpot (WP6), and Attio (WP8) adapters are built on it and must pass the suite. WP15 amends the docs that point here.

## Context and problem

Phase 6 writes approved proposals to three CRMs and the demo CRM. Each CRM has its own API, ids, limits, errors, and story for keeping a write to one. The outbox has to treat them alike, and so do the dry run, the golden tests, and the chaos test. Several things had to be settled before any adapter is written:

- **One plan, three uses.** The dry run ("Preview the write", decision 18) must show exactly what the outbox will send. The outbox's write steps rebuild the plan from Postgres rather than pass it between steps (decision 15). Golden tests hold each adapter's plans still. All three need the same plan from the same input, so planning has to be pure and deterministic.
- **What each proposal writes.** §4.3's table is the same for every CRM in its rows (a new record first, then the activity on it; live checks on a linked update) and different in its cells (property names, value forms, association types). Each adapter re-deriving the rows would drift.
- **Reading a stage.** The extractor writes a stage as the rep named it. Every CRM has its own stage ids. A model call on the sync path would need a key and could guess.
- **Writes that can't land twice.** Workflows retry a step until it succeeds, so a CRM call can commit and run again. No CRM offers an idempotency key, and HubSpot's search lags (decision 7).
- **Errors.** The outbox decides by kind: retry, fail, or take the conflict path. A CRM's error message can quote a record, and some CRMs echo a request's credential back.
- **A bar for every adapter.** Community adapters (Phase 10) need one suite to pass, run the same way against a CRM in memory, a CRM in Docker, a fake, or a live account.
- **The demo CRM.** A workspace with no CRM connected can load the demo CRM. Its approvals should sync too (WP9's zero-setup e2e), with no connection, no network, and no key, and with the same history and arrivals a real CRM's sync leaves in the mirror (ADR-0008).

## Considered options

- **Where requests are built:** **one description per write (`RequestSpec`) that both `requests()` and `execute` build from (chosen)**; requests built inside the I/O code (no dry run); a separate preview renderer (it would drift from what's sent).
- **What each proposal writes:** **§4.3's rows shared, each adapter filling in its column (chosen)**; each adapter planning on its own; a table of property renames (value forms differ too: Twenty nests a person's name, Attio wants arrays).
- **Reading a stage:** **the name toolkit's normalization, then an exact label or word, then trigram similarity of 0.6 or more with one clear winner (chosen)**; a model call; exact matches only.
- **Keeping a write to one:** **three modes (`upsert`, `client_id`, `readback`), `execute` idempotent on its own, and `reconcile` a lookup that writes nothing (chosen)**; search, then create; a lock in Earshot.
- **The reference CRM:** **a CRM in memory behind a REST API of its own, with an adapter that reaches it only through `ctx.fetch` (chosen)**; an adapter that reads and writes the CRM's state directly (faults and limits would be skipped); per-test mocks of `fetch`.
- **Faults:** **three points by seed: before the request, after the commit before the answer, after the answer's status (chosen)**; random failures; faults only in a proxy in front of a real CRM.
- **The suite:** **a Vitest `describe` builder over plain check functions (chosen)**; a test file each adapter copies. Plain functions let the suite's own tests run single checks against adapters broken on purpose.
- **Golden files:** **committed JSON, compared with `toMatchFileSnapshot`, so regenerating is a deliberate `-u` (chosen)**; inline snapshots; hand-written expected plans.
- **The demo adapter's I/O:** **a small API under `demo:`, served from a store in the caller's transaction (chosen)**; the adapter calling the store directly (its dry run would show requests nothing sends, and the suite's transport checks wouldn't apply).
- **The demo CRM's notes, tasks, and meetings:** **a table of their own, `crm_demo_activities` (chosen)**; JSON on the record's row; the `facts` table.

## Decision

### Errors (`packages/crm/src/errors.ts`, `redact.ts`)

**`errorFromResponse(status, body, headers, context)`** maps a CRM's answer to §4.2's kinds:

| Status | Kind | Retried |
|---|---|---|
| 429 | `rate_limited` | yes |
| 408, 5xx | `transient` | yes |
| 401, or a body coded `invalid_grant` | `auth` | no |
| 403 | `forbidden` | no |
| 404, 410 | `not_found` | no |
| 409 | `duplicate` | no |
| 400, 422 | `validation` | no |
| anything else | `unknown` | no |

- **The body** is what the adapter read from the CRM's error: its code, the proposal's field it names (the adapter maps `closedate` to `closeDate`), and, for a taken value, the record that holds it. Never the CRM's message.
- **The message** is fixed words ("HubSpot asked to slow down"). The code is kept only when it's shaped like one (letters, digits, `_.:-`, at most 64 characters, as `checkSyncEvent` requires), and the field only when it's a field name and the kind names fields.
- **Retry advice:** a 429's or a 503's `Retry-After`, as seconds or as an HTTP date (`parseRetryAfter`, `retryAfterMs`). HubSpot sends none, so its 429s carry null and the outbox backs off on its own.
- **`networkError(cause)`:** a call with no answer is `transient`.
- **`CrmError`** gains `existing`, the record a `duplicate` offers, for the conflict path.
- **Redaction.** `CrmError` redacts its own message and makes its cause safe (`redactCause`): a plain `Error` is kept, anything carrying more becomes a copy with only its name, message, and stack, and an object that isn't an `Error` becomes a fixed one. `redact` masks `Authorization` values, `Bearer`, `Basic`, and `Token` credentials, credentials in a query or in JSON, the provider key shapes from `@earshot/core`, HubSpot's `pat-` tokens, and any exact secret it's given. Tokens with no shape (HubSpot's OAuth tokens, Attio's keys) are kept out by adapters never quoting a CRM's text; the suite checks that.

### Planning (`packages/crm/src/plan/`)

**`buildPlan(input, column)`** reads §4.3's rows with an adapter's column (`PlanColumn`: a write's properties from Earshot's own values and its marker, its names for the checked fields, its association-type defaults, and its limits on an activity's body):

| Proposal | Linked record | New record |
|---|---|---|
| Note | a note on the record | the record, then the note |
| Task | a task, assigned to the rep where the CRM has owners | the record, then the task |
| Contact | an update of title, email, and phone, with live checks | the person, linked to their company |
| Deal update | an update of stage, amount, and close date, with live checks | the deal in the new deals' pipeline, linked to its company |
| Commitment | a task ("Commitment: …") when it's due and the mapping says tasks; else a note | the record, then the same |
| Meeting | a meeting where the CRM has them and the mapping says so; else a note ("Meeting: …") | the record, then the same |

- **Values** are the proposal's fields with the review's edits applied (`approvedValues`). A field the reviewer emptied is written nowhere.
- **Order:** a new record is write 0, and later writes point at it (`{ write: 0 }`). Associations go on the create when the CRM takes them inline; otherwise each record's associations are a write of their own, right after it. A plan holds at most 8 writes.
- **Live checks:** each field a linked update writes, against what the reviewer saw (`seen.current`, else `seen.base`), in the mirror's form. A field the card showed no CRM value for isn't checked.
- **Refusals** fail the job before any write: `unmapped` (a stage the mapping can't read, quoting the rep's words unless they're too long or shaped like a key), `unsupported` (the CRM can't hold it: Attio without deals, a missing association type), and `validation` (a value that isn't what it claims, a new record with no name, or a linked update with nothing to change).
- **Markers:** the caller makes them (`PlanInput.markers`, WP1). A plan with too few is the caller's bug, and throws.

**The helpers,** pure and synchronous:

- **`readStage(words, stages)`:** the words normalized as the name toolkit normalizes names (`normalizeName`), then an exact match on a stage's label or one of its words; else the best trigram similarity at 0.6 or more, when no other stage is within 0.1 of it (target, where the spec is silent); else `unmapped`. Two exact matches are ambiguous. A new deal's stage is read within its pipeline.
- **Owners:** `ownerFor(mapping, userId)`. `defaultMapping(schema, capabilities, { reps, words })` makes a mapping the way WP5's version 1 is made (each stage by its label, owners by email, the default destinations), for the suite, the demo CRM, and WP5.
- **Time:** `knownTimeZone` (UTC for a zone `Intl` doesn't know: `session.started` v2's zone is checked only for its shape), `dueInstant` (a date-only due date at 09:00 in the rep's zone), and `zonedInstant` (a meeting's date and time there). Across a change of offset, they read as Temporal's `compatible` does: a skipped time with the offset before the change, a doubled one as the first. `Intl` only, no time zone library.
- **The activity line:** `withActivityLine` ends each activity's body with "via Earshot · ref es_…" after a blank line, cutting the text (never the line) to fit a cap; `markerInBody` and `hasActivityLine` find it again, leniently, since a CRM may turn text into HTML. Records carry their marker in a property, never in their text.
- **Names:** `splitName`: the last word is the last name, a single word a first name only.
- **`markerUuid(marker)`:** a UUID v8 from the marker's 100 bits, for a CRM that lets the client choose a record's id (Twenty, if its creates take one).

**"The session's time"** for a note's timestamp, and for a task or meeting with no date, is the proposal's own time (`ProposalView.ts`): `PlanInput` carries no other.

### The dry run (`packages/crm/src/render.ts`)

An adapter describes each write's requests once (`RequestSpec`: method, path under the API base, headers, JSON body). `previewOf` shows it for the card, with the credential as `Bearer •••` where the CRM takes one; `requestOf` builds the `Request` that `execute` sends through `CrmContext.fetch`, which adds the credential. An earlier write's record shows as a placeholder, `(write-0)`, until it has run; `resolvePreview` swaps in the ids outcomes name (encoded in a URL's path, as adapters encode ids there). `checkSentences` says a plan's live checks in words: "Checks that the stage is still Discovery", a stage held by id read by its label, an amount as money, no value as empty. The previews show the writes; the reads `execute` makes to find a first try are the adapter's own business.

### The reference CRM (`@earshot/crm/testing`)

**`MemoryCrm`** is a CRM in memory behind a small REST API of its own, under `https://memory-crm.test`, which only its own `fetch` answers. It implements `CrmAdapter` through an adapter (`memoryCrmAdapter`) that reaches it only through `ctx.fetch`, as a real adapter must, so its faults, limits, and credential apply to every call.

- **Every capability is configurable:** each idempotency mode for records and activities (`upsert` by the marker property, `client_id` from `markerUuid`, or `readback` through a filtered list, which is consistent at once: by the marker property for records, by the activity line for activities), associations inline or separate, owners on or off, meetings on or off, and deletes reported in `changes` or not. It stands in for Twenty by default (`provider`), since sync events name a real CRM.
- **Faults by seed** (`faults.ts`, mulberry32): before the request (nothing lands), after the commit before the answer (the record lands, the call fails), and after the answer's status (the record lands, its body can't be read). One-off answers can be injected too: a fault, a status, a 429, or an error that quotes the request's credential back.
- **Search lags** 30 s by default, on its own clock, which moves only when a test moves it. No correct adapter searches to find a first try (decision 7); the suite's mutation test shows why.
- **A rate limit** of so many requests a window answers 429 with `Retry-After` until the window ends.
- **Changes** come in the order records last changed, a sequence that only grows, so a cursor is a place in it: no record changed after a cursor sorts before it, whatever its id or time.
- **Its harness** makes fixtures as a CRM user would, reads records back raw, and edits or deletes them behind Earshot's back.

`@earshot/crm/testing` is Worker-safe (no Node APIs, no Vitest), so WP3 can run `MemoryCrm` in workerd. It also holds the view builders tests make `PlanInput`s from, the harness types, and the demo CRM's store in memory.

### The conformance suite (`@earshot/crm/conformance`)

`runConformance(adapterFactory, harness, options)` adds a `describe` per group of §4.2 and an `it` per check to the calling test file. Each check is a plain function (`conformanceSuite`), so the suite's own tests run single checks against broken adapters.

1. **Connection:** `verify` names the account, the actor, and the scopes; `schema` lists stages, owners when tasks can be assigned, and an association type for every pair the plans use.
2. **Plans:** each of the twelve cases (six proposal types, against a linked record and a new one) matches its committed golden file: the plan or refusal, its requests, and its checks in words, planned against fixed ids, markers, and a schema the adapter gives. Planning is deterministic and calls no CRM.
3. **Writes:** each case's plan, executed in order, leaves exactly one record per create, holding its marker and the properties as sent; every association; an update's properties; and `get` reading each checked field back as written. What `execute` sent equals what `requests()` previewed, placeholders resolved.
4. **Twice:** each write executed twice reports `found` (or `updated`, `associated`) for the same record, and leaves one record and one link.
5. **Lost responses:** the suite lets each write's first change through, then drops its answer. `execute` throws a retryable `CrmError`; `reconcile` finds a create's record (the one record holding its marker); the retry reports `found` and leaves one.
6. **Live checks:** a linked update checks each field it writes; `get` reads each as the plan compares it, and sees it move when the harness moves it.
7. **Errors:** a 429 is `rate_limited` with retry advice; a refused credential is `auth`; a deleted target reads null and a write to it is `not_found`; a refused value is `validation` naming its field; a taken email is `duplicate` with the record that holds it.
8. **Changes:** more than two pages of records made, one edited, and one deleted come back once each, in order, the edit with its new name and the delete as deleted.
9. **Limits and secrets:** no request exceeded the CRM's documented page and batch sizes (`options.limits`); no preview holds the harness's credential, which shows as `Bearer •••`; nothing thrown holds it, even when the CRM quotes it back.

**What an adapter can't do** it declares in `options.cannot`, with why (`golden`, `actor`, `auth`, `rateLimit`, `echo`, `refusedValue`, `duplicates`, `deletes`), and each check it skips says why in its name. A check the harness has no means for and no reason given fails rather than skip silently. What capabilities already say needs no option: a CRM without meetings runs the meeting cases as notes, and says so in their names; one without deals expects its deal cases refused as `unsupported`.

**Fixtures** are fresh for each check (ids, keys, markers, names, emails), so checks never collide in one CRM, and a live CRM can be reused between runs.

**It passes** on `MemoryCrm` in four configurations: `upsert`, `client_id`, and `readback`, and HubSpot's shape (upsert records, readback activities, separate associations, no owners, no meetings, no deletes). **It fails,** as it should, four broken copies of `MemoryCrm`'s adapter: one that finds its first try through lagging search (every create lands twice), one that quotes the CRM's answer in its error (the credential leaks), one that reads one page of changes, and one whose preview leaves the associations out.

The suite and its harnesses run in Node under Vitest. `src/conformance` is left out of the package's Worker typecheck (ES2023 and the WebWorker library, no Node types) and checked by its Node config instead; nothing else in `src/` imports Vitest or Node.

### The demo CRM as an adapter (`@earshot/crm/demo`)

- **What it is:** `provider: "demo"`; the demo dataset's stages (HubSpot's defaults, restated so the edge Worker doesn't import the dataset; `@earshot/db`'s tests hold the two lists together), labeled as the inbox labels them; no owners; every write upserted by its marker; associations set on create. Its mapping (`DEMO_MAPPING`) knows each stage by its label and by the id the demo rows hold, which "Keep the CRM's" can put back in a card.
- **Its I/O:** a small API under `demo:` (`demoFetch`), served from a `DemoStore` in the caller's transaction and never over a network. The outbox builds the context with `demoContext(createDemoStore(tx))`; `ConnectionDO` never sees it. So the demo adapter's dry run is what it sends, and the suite's transport checks (lost answers, requests against previews) apply to it as to any adapter. `verify` and `schema` answer from what it is, with no call.
- **`DemoStore`**, which the adapter defines and `@earshot/db` implements (`createDemoStore(tx, { now, newId })`), over the transaction's workspace's demo rows only (no connection, the `demo:` prefix):
  - a record a write makes is a demo row, `demo:added:…` (as Phase 5's "Add a matching record" makes them), with its marker as `writeId` in its properties, its phonetic keys, and its arrival in the history (its name from none, `source: "sync"`), made once per marker under an advisory lock;
  - an update sets properties, with a history row for each field whose value changes;
  - a note, task, or meeting goes in `crm_demo_activities`, once per `write_id`; a task's or meeting's title leads its body, since the row has no title of its own;
  - a contact's email is unique among the workspace's demo contacts, so a taken one is a `duplicate`, with the contact that has it;
  - `changes` pages demo rows by change time, then id. Like any poll by change time, a row changed at the cursor's instant after it was read could be missed; nothing polls the demo CRM in production, since its rows are the mirror.
  - Audit rows are the sync's (WP3), not the store's.
- **`ExternalRef.id`** for a demo record is its mirror row's external id without the `demo:` prefix (`co_001`, `added:…`), as a demo contact's `companyId` already names its company.
- **It passes the suite** twice, against the same golden files (`packages/crm/test/golden/demo/`): on the store in memory, in `@earshot/crm`'s tests, and on Postgres through PGlite and row-level security, one transaction a request, in `@earshot/db`'s. It declares that it has no users (`actor`), takes no credential (`auth`, and the secret checks), is never rate-limited, and keeps nothing of a deleted row.

### Storage: migration 0020

`crm_demo_activities`: `workspace_id`, `id`, `kind` (`note`, `task`, or `meeting`, checked), `entity_id` (the demo record it's on, a composite key to `crm_entities` that cascades), `write_id` (checked to a marker's shape, unique per workspace), `body` (1 to 20,000 characters), `due_at` (tasks only), `starts_at` (meetings only), and `created_at`, with an index on its record. Row-level security by workspace, `SELECT` and `INSERT` only for the app (append-only, like `crm_entity_changes`), and exported with the account as every tenant table is. drizzle-kit generated the table; the row-level security, policy, and grants are by hand. pgTAP covers the reads, the grants, the cross-workspace key, and the checks (`99_crm_demo_activities.sql`). The spec's later migrations move up one: WP5 takes 0021, WP7 0022, and WP11 0023.

## Consequences

**Good**

- What a rep previews is what's sent: one description feeds both, and the suite holds each adapter to it.
- §4.3's rows live in one place. An adapter writes its column and passes the suite; it can't drift on order, live checks, or the activity line.
- A stage is read without a model or a key, the same way at preview time and at sync time.
- A write lands once in each mode, through a retry, a lost answer, or a body cut off, as far as each CRM's reads let an adapter check (decision 7). `MemoryCrm`'s 150-write runs with faults at every point, and the suite in each mode, show it in memory; WP4's Twenty in Docker and WP16's live runs are to show it against real CRMs.
- No error, cause, or preview carries a credential, and the suite checks every adapter for it, including against a CRM that quotes it back.
- The demo CRM syncs with no connection, network, or key, with the same history and arrivals a real sync leaves, so WP9's e2e can run with zero setup.
- The suite fails broken adapters, so passing it means something.

**Bad**

- Each adapter writes its own `RequestSpec`s and error parsing; the suite catches drift, not every bug.
- Golden files for each adapter are a lot of JSON to review when §4.3's table changes, and regenerating them is a deliberate step.
- `MemoryCrm` follows its own small API, not any real one. It proves the SDK's logic and the suite's power, not a CRM's real consistency: WP4's Twenty in Docker and WP16's live runs do that.
- The suite's golden checks are skipped for `MemoryCrm` (the demo CRM and each real adapter have golden files); the planner's own tests cover what they would.
- The demo store's `changes` can miss a row changed at the cursor's instant, and its contact emails are unique only among demo rows.
- `PlanInput` has no session time, so a note's timestamp is the proposal's.
- A linked contact update writes title, email, and phone only: a new name or company for a person in the CRM isn't synced.

## More information

- Spec: `reports/Earshot Phase 6 build spec.md`, decisions 7, 8, and 15 to 18, §4.2, §4.3, §4.4, §4.9, and WP2.
- The SDK: `packages/crm/src/{errors,redact,render,markers}.ts` and `packages/crm/src/plan/`.
- The reference CRM and harnesses: `packages/crm/src/testing/`.
- The suite: `packages/crm/src/conformance/`.
- The demo adapter: `packages/crm/src/demo/`; its store over Postgres, `packages/db/src/demo-store.ts`.
- Storage: `packages/db/migrations/0020_crm_demo_activities.sql` and `packages/db/test/pgtap/99_crm_demo_activities.sql`.
- Tests: `packages/crm/test/` (the planner, the renderer, errors and redaction, `MemoryCrm`, the suite on `MemoryCrm` and on the demo CRM in memory, the mutation tests) and `packages/db/test/demo-store.test.ts` (the suite on Postgres, and the store).
- Regenerate the demo CRM's golden files on purpose with `pnpm --filter @earshot/crm test -u`, and review the diff.
