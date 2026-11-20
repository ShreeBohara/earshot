# ADR-0030: Normalizers and the faithfulness check: chrono with Intl's offset and Earshot's weekday rules, a hand-written amount parser, NegEx-style negation, correction markers, and replacing a value only when its reading is unique

## Status

Proposed (2026-11-20). Phase 4 WP7 built the normalizers and the faithfulness check in `@earshot/understanding` (`./normalize`, `./faithfulness`). WP8 (2026-11-20) calls them from `understand()` in `SessionDO` on every field, retires `@earshot/agent`'s `risk.ts` patterns, and settles what `unsupported` means (see "WP8: the risk patterns, and `unsupported`"). Builds on ADR-0027 (the v2 contracts: `FieldNorm` and the seven new risk kinds) and follows the Phase 4 build spec's decisions 9 to 13.

## Context and problem

The extractor writes each field's value and quotes the words it came from (ADR-0025). Dates, amounts, and negations are the costliest values to get wrong: the plan's research measured real transcription errors costing 22 to 26 points of tool-call accuracy on exactly these. Phase 3 only flagged them with patterns (`@earshot/agent`'s `risk.ts`): any date field, any number, any negation within three words. Phase 4 checks them instead:

- read every date and amount quote deterministically, against the call time in the rep's time zone;
- notice a quote that sits in a negation, or that the rep took back ("Thursday, sorry, Friday");
- check every field's value against its quote, and say so when they disagree.

Three facts shape the design:

- **chrono-node can't take an IANA zone.** Its reference is `{ instant, timezone }`, with the zone as an abbreviation or a minute offset (its `toTimezoneOffset` reads only an abbreviation map). Its `date()` builds an instant with that one offset, which is an hour off once the clocks change in between.
- **chrono's weekday rules aren't Earshot's.** A bare weekday resolves to the closest day, and with `forwardDate` the call's own weekday is today for a morning call and next week for an afternoon one. "next Friday" said on a Tuesday is ten days away, and speakers disagree on whether they mean three or ten. `forwardDate` also pushes "last Friday" into the future.
- **The model's value and a deterministic reading can both be wrong.** Overwriting the model whenever a rule disagrees trades one error for another; never overwriting leaves a known-wrong date on the card.

## Considered options

- Dates: **chrono-node 2.10.3 (English only) with Earshot's rules computed from Intl's local date**; leaving dates to the model; a hand-written date parser.
- Amounts: **a hand-written parser**; `words-to-numbers` 1.5.1 (2018); `compromise` 14.20.0 (2.9 MB unpacked).
- Negation: **NegEx-style triggers and forward scopes, as a risk flag**; an LLM judge per field; the Phase 3 three-word lookbehind.
- When a reading disagrees with the model: **replace only when the reading is unique and certain, keeping the model's value**; always trust the model; always overwrite it.
- Ground truth: **the evals keep their own resolvers, held to the product's by a conformance test**; one shared implementation.

## Decision

### Dates (`resolveDate(quote, callTime, timeZone) → { readings, certain, relative } | null`)

- **chrono's casual English parser**, imported from `chrono-node/en` so its other 15 locales stay out of the bundle. The reference is `{ instant: callTime, timezone: offsetMinutes }`, the offset computed by `Intl` for the call instant, with `forwardDate: true`.
- **Components, never `date()`.** A reading is chrono's year, month, and day. `date()` and a conversion back to the rep's zone would put "in two weeks" from 00:30 CDT on 2026-10-25 on 2026-11-07 instead of the 8th; a test keeps that control. chrono computes relative days from a `Date` moved into the system's zone, so the call's local date from `Intl` is compared with chrono's and any skew is corrected (none in workerd, which runs in UTC). The daylight-saving table passes under five system zones.
- **Earshot's rules, from the call's local date, not chrono's day:**
  - A bare weekday ("by Friday", "this Friday", "this coming Friday") is the first one after the call, 1 to 7 days on; the call's own weekday is a week later, morning or afternoon.
  - "next Friday" has two readings, the coming Friday and the one after, and gets `ambiguous_value`. "Friday next week" has one: the Friday of the week after the call's, weeks starting on Monday. "last Friday" is the one before the call.
  - A weekday said with a date names the date if they agree ("next Friday the 27th"); if they don't ("Thursday, December 4th" when the 4th is a Friday), both readings stand.
  - End of the week (EOW) is its Friday: today on a Friday, the coming one at a weekend. End of the month (EOM) is its last day. End of the quarter (EOQ) is the calendar quarter's last day; fiscal quarters aren't known. End of the year (EOY) is December 31. "end of next week, month, quarter, year" move one period on; "end of Q1" is the next quarter by that name. EOD, end of day, and close of business are today, unless a day is named beside them ("EOD Friday").
  - A month and day with no year is the next one on or after the call's date (the call's date counts). "the 15th" is the next 15th on or after the call's date. Also: "the day after tomorrow", "a fortnight", "a week from today" or "from tomorrow".
- **`certain` is false for a period with no day:** "next week", "in December", "in a couple of weeks", "the week after next", "Q1", a weekend. Its reading is only a guess, so the faithfulness check neither replaces nor rejects the value; it flags `ambiguous_value`.
- **Several expressions** in one quote ("Tuesday or Wednesday") give all their readings, up to three; more is no reading.
- **Times** (`resolveTime`, for WP8's `meeting.time`): "3pm" is 15:00. "at 3" has both readings, the business-hours one first. A meeting time on a day the zone's offset changes (`offsetChangesOn`) is flagged `ambiguous_value`, as the spec's risk table asks.

### Amounts (`parseAmount(quote) → { value, readings, currency, ambiguous } | null`)

- **Forms:** digits with commas and decimals; words, with or without "and" and hyphens ("a hundred and twenty thousand", "forty-five hundred", "one point five million", "half a million", "one and a half million"); shorthand ("45k", "fifty k", "40 grand", "2 mil", "$1.2M", "$3mm").
- **Ranges and alternatives** ("50 to 60k", "$50-60k", "between fifty and sixty thousand", "fifty or sixty grand") have two readings and are ambiguous. The low end borrows the high end's scale when it has none and reads no larger ("between 900 and 1.2 million" keeps 900).
- **Currencies:** "$", USD, dollars, and bucks are USD; "€", EUR, and euros are EUR; "£", GBP, pounds, quid, and sterling are GBP. No currency word means `currency: null`, not USD.
- **Not amounts:** percentages, ordinals ("4th"), and times ("3pm"). A lone number word or numeral under 100 with no currency or scale is marked `bare`, so the correction check doesn't take "one more thing" for an amount.
- A property test writes every magnitude up to 999,999,999 out in words, in three styles, and parses it back.

### Negation (`isNegated(text, span)`)

- **Triggers:** not, no, never, without, cannot, none, nothing, nobody, neither, nor, every "n't" contraction (and the same contractions without an apostrophe, as speech-to-text sometimes writes them), and the longer "no longer" and "not going to", whose scope starts after their last word.
- **Scope:** up to 6 words forward, ended by but, however, although, though, except, still, or clause punctuation. A trigger with nothing after it ("No, they signed") has no scope.
- **Pseudo-triggers,** ignored: no problem, no doubt, not only, not just, no worries, no question, no matter, not to mention, nothing but, and the correction marker "no wait".
- **Output:** whether the quote touches a trigger or its scope. Any field so placed gets `negation`, beside the model's own reading. On the 30 scripts, 6 expected fields do: five note bodies that state a negative fact, and "at no extra cost".
- Forward scopes only: "Marshal Medical isn't involved" doesn't negate "Marshal Medical", and the 6-word window misses a seventh word ("Don't mix them up with Northwind Labs or Northwind Foods").

### Corrections (`findCorrection(text, span, find)`)

- **A correction** is a value, at most two fillers ("uh", "no", "or", another marker), a marker (sorry, actually, no wait, I mean, I meant, scratch that, make that, rather, correction), at most three words ("it's", "make it"), and a value of the same kind, all in one utterance. Dates and amounts have finders; in a chain, every value but the last is taken back.
- **A quote that stops at the value taken back** gets `self_correction`, and `value_mismatch` unless the model wrote the new value. Nothing is replaced: the quote's own reading is the retracted value, and replacing with it would undo a model that got the value right.
- **A quote that runs past the marker** is read as the new value; a model that kept the old one gets `self_correction` and `value_mismatch`, and the new value's unique reading replaces it.

### Faithfulness (`checkField(input, context) → { value, norm?, flags, verdict, overlap? }`)

| Field kind | Fields | Check | On failure |
|---|---|---|---|
| `name` | a contact's name and company, a counterpart | Equal to the quote once normalized (`normalizeName`: case, punctuation, legal suffixes) | `value_mismatch`, kept |
| `email` | email | Equal once normalized, spoken forms written out ("dana dot lee at acme dot com") | `value_mismatch`, kept |
| `phone` | phone | The same digits, spoken or written, a leading country code 1 aside | `value_mismatch`, kept |
| `date` | dueDate, closeDate, a meeting's date | Among the readings | Unique: replaced. Ambiguous: `ambiguous_value` (and `value_mismatch` if not among them). No reading: `unsupported` |
| `time` | a meeting's time | Among the readings | As dates |
| `amount` | amount | Equal to the parsed amount | As dates. A currency other than the field's (USD unless set): `value_mismatch`, never converted |
| `verbatim` | a deal stage, a job title | Word for word inside the quote | `value_mismatch`, kept |
| `text` | note bodies, task titles, commitments, a meeting's title and attendees | At least 0.5 of the value's content words in the turn (stemmed, number words as digits) | `weak_support` |

- **Decision 12:** a unique, certain reading of a date, time, or amount replaces a disagreeing value. The model's value goes to `norm.llmValue`, with `value_mismatch`. Every reading of an ambiguous quote goes to `norm.readings`, and the model's value stands. `norm.currency` records a currency the words name.
- Names, emails, phones, and stages are never replaced: their only "reading" is the transcript's spelling, which may be the mishearing.
- `verdict` (`supported`, `replaced`, `ambiguous`, `mismatch`, `unread`, `weak`, `unchecked`) is for WP10's report of the normalizers' catches; it isn't part of the contract.
- **Flags** come in a fixed order: `self_correction`, `value_mismatch`, `ambiguous_value`, `unsupported`, `weak_support`, `negation`. WP8 decided the `date`, `number`, and `low_confidence` flags (below).
- The package restates `FieldValue`, `FieldNorm`, and the flag shape rather than importing `@earshot/core` (as the linker restates its types); a type test in `@earshot/evals` fails to compile if they drift.

### WP8: the risk patterns, and `unsupported` (2026-11-20)

Phase 3's `risk.ts` raised four flags by pattern: `date`, `number`, `negation`, and `low_confidence`. WP8 removed the file. `understand()` now raises, per field, `checkField`'s flags (`negation` among them), then `low_confidence`:

- **`date` and `number` are retired.** They flagged every date field and every quote with a digit or a number word, because nothing checked those values. Now `checkField` reads each date, time, and amount from its own words: a value that agrees passes unflagged; one that disagrees gets `value_mismatch` (replaced, if the reading is unique), `ambiguous_value`, `self_correction`, or `unsupported`. A blanket badge on every right date would only add to the flag rate (WP10's guard is 35% or less). Stored Phase 3 events keep theirs, and the tray still labels them.
- **`negation`** now comes from the NegEx-style check above, on every field, instead of `risk.ts`'s "a negation word in the quote or the three words before it".
- **`low_confidence` stays** as Phase 3 had it: evidence below 0.7 (the lowest word's confidence, with word timings). It's about the transcription, which nothing else checks.
- **Accepted gap:** a number inside free text (a note's "nine thousand six hundred dollars") is no longer flagged by itself. Free text is checked only for support (`weak_support`); WP10's seeded "model-like" errors will show what that costs.

**`unsupported` means one thing** everywhere (ADR-0027): the words the model cited don't back what it wrote. Phase 3 used it for a quote not found in the transcript (the field is dropped, and the flag names it). The faithfulness check uses it for a date, time, or amount quote with no reading of that kind (the value stays). Spec §4.3 uses it on the target for a name not found (nothing is linked). Each is a case of the one meaning. The contract's documentation, the pipeline, and the tray ("Not backed by what was said") all say so.

### Ground truth (decision 13)

`@earshot/evals` keeps `resolveDatePhrase` and `parseUsd`. Its `test/normalizers.test.ts` holds the two to the same answers on all 37 scripted dates and 13 scripted amounts, and on the phrases the evals' own tests resolve. Where the evals refuse ("next Friday", "the week after next"), the product never pins one certain day.

## Consequences

- **Measured on the 30 scripts:** every scripted date and amount resolves to its expected value, alone and certain. Every expected field passes the faithfulness check unchanged. WP7 found three company names the Phase 3 scripts expanded past their quotes ("Akme" written "Akme Dynamics", "Sigma", "Verdant"); WP8 rewrote them as said, and the linker resolves the company (ADR-0027). A wrong date (a day off) or amount (ten times) is replaced with the expected value every time. The lowest free-text overlap is 0.60.
- **Cost:** about 0.02 ms per turn at the median and 0.14 ms at p95 for every field check on the scripts, 3.6 ms for the first, cold turn (this Mac, Node 26), against the pipeline's 20 ms p95 target.
- **Bundle:** chrono-node's English parser adds about 104 KB unminified (48 KB minified, 14 KB gzipped). The package's product entries together grow from about 79 KB to 233 KB unminified (36 KB to 109 KB minified; 14 KB to 37 KB gzipped). Importing `chrono-node` itself would carry all 16 locales, about 486 KB; the bundle test fails if any locale but English comes along. WP8 measured the edge Worker: +222 KiB, +48 KiB gzipped, with the linker (ADR-0027); startup waits for the first deploy.
- **Known gaps:** fiscal quarters; "between Tuesday and Thursday" said on a Tuesday; corrections of names and stages (dates and amounts only); spoken emails spelled letter by letter; backward negation ("X isn't involved"); and amounts in other currencies are flagged, never converted.
- **Flag rate:** a negated note body is flagged even when the model kept the negation. That is v1's behavior, narrowed by scopes and pseudo-triggers; WP10's flag-rate guard (35% or less) will show whether it's too loud.

## More information

- The Phase 4 build spec, WP7 and decisions 9 to 13; the tooling check, §4 (chrono's `timezone.ts` and `calculation/weekdays.ts`, the amount libraries, NegEx).
- Chapman et al., "A simple algorithm for identifying negated findings and diseases in discharge summaries", *J Biomed Inform* 34(5), 2001.
- Code: `packages/understanding/src/normalize/` and `src/faithfulness.ts`; tests in `packages/understanding/test/{dates,amounts,negation,corrections,faithfulness}.test.ts` and `packages/evals/test/normalizers.test.ts`.
