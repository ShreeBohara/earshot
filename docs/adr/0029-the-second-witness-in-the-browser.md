# ADR-0029: The second witness in the browser: each turn's audio to Groq Whisper on the user's key, compared in SessionDO in the session's order

## Status

Accepted (2026-11-20). Phase 4 WP9 built it: the Groq Whisper runner, each turn's audio buffer, the session's witness queue, the price row, Settings → Capture with its one-time consent, `SessionDO`'s handling of `witness`, the scripted fake witness, and the end-to-end test of a mishearing. **The live check is pending the user's approval**: ten real turns from the user's own browser, under $0.01 (see "The live check"). Until it runs, everything about Groq's answers here is as documented, not observed. The fallback witness (spec WP9 step 7, cut third) isn't built. Amended for Phase 5 (2026-11-25): each turn's audio is also kept for evidence clips, on the device, whether or not the witness runs; see "Amendment: Phase 5" below and ADR-0036.

Builds on ADR-0027 (the `witness` message, `proposal.flagged`, `turn.witnessed`) and ADR-0028 (`readUnbiased`, `compareWitnesses`, θ_d). Amends ADR-0002: one provider key, the user's Groq key, goes from the browser straight to its provider, since Groq mints no short-lived credential for batch transcription. Follows ADR-0021 for where that key lives.

## Context and problem

The biased stream is boosted with the session's CRM names, so it can write a new company as a CRM spelling ("Atmos Industrial" for a rep who said "Atmo Systems"). A link from that is confidently wrong, and nothing in the transcript shows it. Spec decision 6 adds a second, unbiased witness: after each turn, the browser sends the turn's audio, with no keyterms and no prompt, to Groq's `whisper-large-v3-turbo` on the user's own Groq key, and `SessionDO` compares the two transcripts at every name (§4.6). A conflict turns a link into a question after the card has appeared (decision 7), so the witness never delays the first card.

That needs:

- each turn's audio, on the same clock as the biased stream's words, kept past Phase 3's 60 s replay ring;
- a request to Groq that follows the spec exactly, and keeps the key between the browser and Groq;
- a `witness` message per turn, in order, after the turn's `turn_end`, with the provider's usage metered;
- `SessionDO` comparing as soon as both the proposals and the transcript exist, whichever comes first, with the context the turn's linking used, even after the object hibernated;
- the rep's consent, since the audio goes to a second processor (decision 8).

## Considered options

- **Each turn's audio:** a buffer per turn in the Debrief engine, fed the frames the speech stream takes (chosen); the speech stream's 60 s ring (too short for the spec's 120 s cap, and it has no tail past the release); a second capture graph (double the audio work, and its clock would drift from the biased stream's).
- **A witness that arrives before extraction:** wait on the session's chain behind the turn and answer once compared (chosen); acknowledge at once and persist a pending reading (two commits for one message, and a restart between them needs recovery code); refuse it and have the client retry (a timing-dependent error path).
- **The link context for a late witness:** keep, per turn, what each proposal's linker read (chosen); rebuild it from the proposals' events (the turn's dropped drafts and its earlier `link_recent` are gone by then).
- **When the witness runs:** in parallel once `turn_end` is queued (chosen, spec step 3); before `turn_end` (it would hold up extraction, against the 2.5 s card budget).
- **Consent:** asked once per device with "yes" preselected, only when a Groq key is there (chosen, decision 8); on silently; off with no prompt.

## Decision

### The request (`packages/voice/src/witness/groq.ts`)

- **Exactly the spec's request.** A WAV of the turn (PCM16, mono, 16 kHz, a 44-byte header) to `POST https://api.groq.com/openai/v1/audio/transcriptions`, multipart: `file`, `model=whisper-large-v3-turbo`, `response_format=verbose_json`, `timestamp_granularities[]=word`, `language=en`, `temperature=0`, and no `prompt`.
- **The key.** It goes in `Authorization: Bearer`, only to `api.groq.com`, with `credentials: "omit"` and `referrerPolicy: "no-referrer"`. It's read from the device store (`DeviceKeyStore`) for each request and dropped after it, so it's never in the outbox, the session store, a log, or a message. `ClientMessage`'s key-shape check would refuse a `witness` message carrying one anyway.
- **Handling.** Each attempt times out at 10 s. A 429 or 5xx is retried once, after `retry-after` (delta seconds or an HTTP date; one second when absent). A wait past 10 s isn't worth it, so that turn fails at once instead. Any other status, a network failure, or a CORS refusal fails without a retry.
- **Failure codes** are `turn.witnessed`'s reasons: `rate_limited`, `provider_error`, `timeout`, and `no_key` when the device holds no Groq key. An answer with no text is a `provider_error`, since there's no transcript to compare.
- **The answer.** Words move to the session's clock: the turn's start plus each word's time, in whole ms. The text's whitespace is collapsed. The utterance is labelled `witness: "unbiased"`.
- **Confidence** is a proxy, never compared with the biased witness's: exp(segment `avg_logprob`), clamped to [0, 1], by the segment that holds each word, and the utterance's weighted by segment length. Groq documents no word confidence, and says word-only granularity "returns only word, start, and end timestamps", so segments may not come back. Then every word gets `UNKNOWN_CONFIDENCE`, 0.5.

### Each turn's audio (`turn-audio.ts`, the Debrief engine)

- **What's kept.** With `turnAudio` on, the engine keeps a recording per turn, from the press to the release plus 200 ms. A recording starts where the turn's first sample lands on the session's clock, the speech stream's end at the press. It takes the same frames the speech stream takes, so sample k is the clock's sample `start + k`: a test checks the two sample for sample. Muted audio is skipped in both.
- **The tail.** After the release, the recording takes 200 ms more of the microphone's audio, which the speech stream mostly doesn't get. That's for the end of a word cut by an early release. The tail's words land at most 200 ms past the turn's audio on the clock, inside `SessionDO`'s 1 s allowance.
- **The cap.** Past 120 s, a recording drops its audio at once and only counts on, and the turn is skipped as `too_long`.
- **Emitting it.** The engine emits `turn_audio` once per `turn_end`, after it, as soon as the tail is in: usually first, because the provider's finalize takes longer than 200 ms. A late final's turn has no audio of its own (`audio: null`).
- **Hands-free turns** have no press. A recording runs while the engine streams, and the provider's end of turn splits it 200 ms past the turn's last final, or where the capture stands if that's sooner. The end of turn lands a silence wait and a network hop after the last word, and the rep may be into the next sentence by then. So the samples already captured past the split start the next turn's recording, on the same clock, and the next sentence's opening words, often the name to check, are its own. Leaving hands-free, whose finals may still be coming, cuts where it stands, and a long silence drops the recording. (Codex found the cut-on-arrival bug on #47; fixed in 210c668.)
- **Off by default.** Without `turnAudio`, the engine keeps nothing past the ring, as before.

### The session's side (`packages/voice/src/session/witness.ts`)

- **Running it.** `SessionWitness` runs the witness on a turn's audio once the turn's `turn_end` is in the outbox. Witnesses go out in turn order, whichever answer comes first; a turn waits for the one before it, bounded by that request's timeouts.
- **Nothing to send.** No message goes out for a turn with no audio of its own, under 1 s of audio, or nothing the biased stream heard. Whisper invents text on near-silence and Groq bills 10 s anyway, and `SessionDO` would have no window to check such a turn against. `turn.witnessed` has no reason code for these, so they're left out rather than mislabelled.
- **Every other turn** gets a message: the transcript (with a `usage` message after it); `skipped` with `off`, `no_key`, or `too_long`; or `failed` with the provider's reason.
- **Fitting the transcript.** Only the words within 0.9 s of the turn's own words are kept, so `SessionDO`'s 1 s check can't refuse a transcript for a word Whisper invented in the silence after the release ("Thank you."). The text is rebuilt from the kept words when any went. The text is cut to the socket's 4,000 characters, and the word timings are dropped if they'd overflow the 64 KiB frame; alignment still reads it then.
- **The end.** The controller's `end` waits up to 12 s for the last turn's witness to reach the outbox: `SessionDO` refuses a witness after `end`.

### `SessionDO` (`apps/edge/src/session-do.ts`)

- **Refusals**, all as `bad_message`, not retryable: a witness for a turn that never ended here (no `turn_end` running, no completed turn), a second witness for a turn, an utterance id already in the log, and an utterance (or any of its words) more than 1 s outside the span of the turn's biased utterances. A turn with no biased utterance has no span, so its witness is refused too.
- **Resends.** A resend is answered by msgId, as every message is. One that arrives while the first waits starts nothing.
- **Ordering.** A witness for a finished turn is compared at once. One for a turn still queued or running waits on the session's chain: it's compared right after that turn's extraction, before anything queued after it, the session's `end` included, and its ack comes when its events are written. Since the client sends witnesses after their turn's `turn_end`, and in turn order, comparisons run in turn order. A witness arriving while a later turn runs is compared at once, between that turn's events, and changes nothing that turn reads.
- **The link context.** Each turn's commit keeps, in a new `turns` table, what each proposal's linker read (`ProposalLink`): the target, the mention as linked, the kinds allowed, the earlier links that proposal saw, and the turn's other named records. A witness that comes after a hibernation is compared with the same `LinkContext`, against the index rebuilt from the stored entities.
- **Events.** One transaction writes the unbiased `utterance.final` (filed under the turn), a `proposal.flagged` for each conflict, then `turn.witnessed` (`compared`, the conflict count, the client's latency), and records the turn as witnessed. A failed or skipped witness writes `turn.witnessed` alone. A flag the event registry refuses (a bug in the comparison) is dropped and the witness recorded without it, rather than lost. A purge while a witness waits writes nothing. The log line holds counts and codes only.
- **Extraction** still reads only the biased witness's utterances (WP8).

### The comparison (`packages/agent/src/witness.ts`)

`witnessTurn` follows WP5's guidance, per proposal whose target was named. A contact's target is named by its `name` field, so the spec's "each contact `name` field" is this same comparison. Implied targets and targets with no words are skipped.

1. `readUnbiased` reads at the target's evidence: by time only when the biased utterance had word timings, since an evidence window interpolated by character position is no window to read by; by alignment otherwise.
2. The company said with it is read the same way. Then the unbiased words are read as the linker read the biased ones: a deal's company folded into its words (`linkerMention`).
3. `compareWitnesses` runs with the stored context.

A conflict becomes `proposal.flagged`: `witness_conflict` on the target, a downgrade to "ask" with the merged candidates (the old target first) when the target was "linked" or "new", and both readings, with the unbiased one's window. An unavailable reading is never a conflict, and agreement changes nothing.

### Usage and price

- `usage` for a transcript reports the audio sent, with no socket time, priced by a new row: `groq/whisper-large-v3-turbo`, $0.04/hr, `billedOn: "audio"`, and a new field, `minBilledMsPerRequest: 10_000`. A 3 s turn bills 10 s ($0.00011), and a 15 s turn bills 15 s.
- The table's date moves to 2026-11-20.
- Usage is reported only for a 200: a request that timed out may still have been billed, and isn't metered.

### Consent and the screen (`apps/web`)

- **The setting.** Settings → Capture has "Second witness": off, or Groq Whisper, with the spec's line, "Sends each turn's audio to Groq too, about $0.001 per debrief." Groq Whisper needs a Groq key on the device.
- **The question.** The capture screen asks once per device (decision 8), only when a Groq key is on it, with "yes" preselected, and says to turn on Groq's Zero Data Retention first. The answer lives in the browser's localStorage, beside the device's keys, so another device asks again. Unanswered is off: nothing goes to Groq without a yes.
- **What a debrief runs.** Each debrief reads the answer as it starts: Groq Whisper (`on`), on with no key (`no_key`), or `off`. The engine keeps turn audio only when the witness runs.
- **The capture screen** shows the witness's state ("Second witness: Groq Whisper", "off", or "on, but no Groq key on this device") and how many names it heard two ways.
- **The tray.** The card shows a conflict pill ("Heard two ways") with the live transcript's words and the second witness's, beside the badge "Transcripts disagree on the name". The transcript panel stays the live stream's alone.
- **The fallback witness**, a second socket without keyterms, is cut (spec §7, third). Without a Groq key there's no second witness, and the screen says so.

### Tests and the fake witness

- **The fake witness.** `createFakeWitness` (`@earshot/voice/testing`) answers each turn from a script: a transcript spread like the fake adapter's, a failure, or a delay gate.
- **Fake mode.** It runs the fake witness when the page sets `__earshotFakeWitness`, and the witness off otherwise. The fake witness never looks at the audio.
- **Consent's e2e** (`apps/web/e2e/capture/witness-consent.spec.ts`): with a Groq key, the capture screen asks once with "yes" preselected and doesn't ask again; Settings → Capture changes the answer; without a Groq key nothing is asked and Groq Whisper can't be picked; axe passes in both themes.
- **The e2e** (`apps/web/e2e/capture/second-witness.spec.ts`) plays eval script d003 through fake mode against the e2e Worker's cassettes. The witness hears "Debrief from Atmo Systems…" where the live stream heard "Atmos Industrial". The card's link to Atmos Industrial (the open account) becomes "Ask: Atmos Industrial, a new record, …", with the conflict pill and both readings; the second line, heard alike, gets no pill.
- **Unit and workerd tests.** The WAV header and sizes; the request's fields and a `verbose_json` fixture written from Groq's docs; every failure code; the key canary (the URL, every header but `Authorization`, the multipart body, the WAV's bytes, the result, and the log); the recorder; the engine's turn audio in both modes; the session queue's order and skips; and the controller with consent, without, without a key, and `end` waiting. In `SessionDO`: a witness after extraction, before it, resent, after a hibernation, agreeing, failed, refused four ways, and purged mid-wait.

### Measurements

- **Bundle.** The edge Worker's dry-run bundle grows from 2,713.20 KiB to 2,738.54 KiB, gzip 511.42 to 517.55 KiB: +25.34 KiB, +6.13 KiB gzipped. That's the witness comparison's reading code, `witnessTurn`, and `SessionDO`'s handling. The web Worker's bundle check still finds no fake-voice code.
- **Groq's latency** is unmeasured until the live check.

## The live check (pending the user's approval)

Ten turns from the user's own browser, on the user's Groq key, with Zero Data Retention on: under $0.01 (ten requests at the 10 s minimum is $0.0011). It's to:

- record the witness's latency (`turn.witnessed.latencyMs`, median and p95) for 10–20 s turns;
- confirm a real POST from the page carries CORS headers, as the preflight did (`access-control-allow-origin: *`, probed 2026-11-20);
- check whether `verbose_json` returns segments with word-only granularity. If it doesn't, the confidence proxy reads nothing, and the request should add `timestamp_granularities[]=segment`, which Groq's docs say costs no latency. That's a one-line change, held back because the spec fixes the request;
- check whether words carry any confidence, and what Groq's free-tier Whisper limits are (spec Appendix B, questions 4 and 5);
- save one conflict as a screenshot.

Nothing in WP9 called Groq or any other paid API. The tests use a fake `fetch`, and the e2e uses the fake witness.

## Consequences

**Good**

- A new name snapped to a CRM spelling becomes a visible question instead of a confident wrong link, and the card appears as fast as before.
- The audio and the Groq key go from the browser to Groq only. Earshot's servers see the transcript, never the audio or the key.
- The witness's words line up with the biased stream's by construction, so the comparison reads by time where both sides have timings.
- Comparisons are atomic and idempotent per message, survive hibernation, and run in turn order without holding up extraction.
- Every turn of every session records how its witness ended (`turn.witnessed`), so WP10 and WP11 can measure failure and conflict rates.
- It costs about $0.001 per debrief, metered in the session's cost.

**Bad**

- The user's long-lived Groq key is in the page's memory for each request, as device keys are when they're decrypted for a mint, and leaves the browser for a third party. ADR-0002's short-lived-credential rule doesn't hold for this provider.
- A Content Security Policy, if one is added, must allow `connect-src https://api.groq.com`.
- A witness for a turn still running holds its message on the client, and its ack on `SessionDO`, until extraction finishes. A deploy in between loses both, and the client resends them in order.
- Groq bills 10 s per request, so short turns cost more than their audio. Taps under 1 s are skipped for that reason, among others.
- `end` can wait up to 12 s on a slow witness, and a slower one is lost when `SessionDO` refuses it after `end`.
- The 0.9 s trim drops words the biased stream missed at a turn's edges. They're outside every quote, so no comparison needed them, but the stored unbiased transcript is shorter than what Groq heard.
- A turn with no witness message at all (no audio, a tap, silence) leaves no `turn.witnessed`, since the contract has no reason for it.
- Until the live check, the confidence proxy and the CORS behaviour of a real POST are as documented, not observed.

## Amendment: Phase 5 (2026-11-25)

Evidence clips (ADR-0036) reuse the turn audio this ADR built, rather than a second recorder.

- **Recorded for either reason.** The Debrief engine records each turn's audio when the witness runs or the device keeps clips: `turnAudio` is `witness.recordsAudio || clips.enabled()`, read as each engine starts (`apps/web/lib/capture/controller.ts`). Clips are on by default, per device, in Settings → Capture, so most debriefs record turn audio now, witness or not.
- **The same recording, two destinations.** Each turn's `turn_audio` goes to the witness when it runs (to Groq, on the rep's key, as above) and, while clips are on, to the clip store (`clips.keep`), which encrypts it on the device for 24 hours. A turn past the 120 s cap is kept as a record with no audio that says so; a late final's turn, with no audio of its own, keeps nothing.
- **The witness's rule is unchanged.** Recording for clips sends nothing anywhere: without the rep's consent, or without a Groq key on the device, no audio goes to Groq. Clips never leave the device, and nothing in a message to `SessionDO` carries audio.
- **One clock.** Sample k is still the session clock's sample `start + k`, which is what lets a clip play a field's evidence span exactly. While a clip plays, a hands-free engine is muted, and muted frames are skipped by the speech stream and the recorder alike, so the clock stays one and the clip's sound can't come back as a turn; pressing push-to-talk stops the clip.
- **Spoken corrections** (ADR-0038). A turn the tray's microphone armed as a correction is sent as `correct`, not `turn_end`, and the witness drops it: there's nothing to compare, since a correction is read by `correctProposal`, not extracted. Its clip is kept like any turn's.

## More information

- Spec: `reports/Earshot Phase 4 build spec.md`, decisions 6–8, §4.2, §4.6, §4.7, and WP9.
- Voice: `packages/voice/src/witness/{runner,groq,turn-audio,wav}.ts`, `packages/voice/src/session/witness.ts`, `packages/voice/src/engines/debrief/debrief-engine.ts` (`turnAudio`), `packages/voice/src/prices.ts`, and `packages/voice/src/testing/fake-witness.ts`.
- Comparison: `packages/agent/src/witness.ts`, and `ProposalLink` from `runTurn`.
- `SessionDO`: `apps/edge/src/session-do.ts` (`#witness`, `#settleWitness`) and `apps/edge/src/session/store.ts` (`turns`).
- Web: `apps/web/lib/capture/{witness,controller}.ts`, `apps/web/components/capture/{witness-prompt,witness-settings,proposals-tray}.tsx`, and `apps/web/app/(app)/settings/capture/page.tsx`.
- Tests: `packages/voice/test/{witness-groq,witness-audio,session-witness,engine-bridge,debrief-engine}.test.ts`, `packages/agent/test/witness.test.ts`, `apps/edge/test/sessions/witness.test.ts`, `apps/web/test/capture-controller.test.ts`, and `apps/web/e2e/capture/{second-witness,witness-consent}.spec.ts`.
