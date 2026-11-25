# ADR-0036: Evidence clips on the device: each turn's audio reused, encrypted in IndexedDB for 24 hours, never uploaded, and designed for when it isn't there

## Status

Accepted (2026-11-25; proposed 2026-11-20). Phase 5 WP9 built it (below): `@earshot/voice/evidence` (the clip store, the span arithmetic, and the player), the capture controller keeping each turn's clip, the play buttons and no-audio lines on the inbox's card in the inbox and the capture tray, Settings → Capture's switch, the capture screen's notice, and sign-out clearing the store. Threat model v1.3 covers it (`docs/threat-model.md`). WP14 amended ADR-0029 (turn audio kept for clips too) and ADR-0021 (the evidence key on the device) to point here. Unchecked until the maintainer's device passes (spec WP16): IndexedDB under iOS Lockdown Mode, iOS Safari under storage pressure, and playback on an iPhone (spec Appendix B, #5 and #6).

## Context and problem

Every field on a card shows the words it came from (`Evidence`), but words can be misheard, and the quote is the transcript's reading of them. Hearing the words settles it: a reviewer who doubts "Dana Lee" wants the second and a half of audio behind it, right after the debrief, without leaving the card.

What that has to work within:

- **Audio stays out of Earshot's servers.** Audio goes from the browser to the speech-to-text provider (ADR-0002, ADR-0022), and, with the rep's consent, to Groq for the second witness (ADR-0029). Earshot's servers have never seen it, and clips mustn't change that.
- **The engine already holds each turn's audio.** `TurnAudioRecording` keeps PCM16 at 16 kHz per turn for the witness, and its sample k is the session audio clock's sample `start + k`: the clock `Evidence.audioMs` counts in. A field's span maps to samples exactly.
- **No browser runs code on a schedule.** Nothing deletes a clip at its 24-hour mark; Storage Buckets' `expires` is Chromium-only and applied lazily too.
- **Storage can vanish.** Best-effort storage is evicted under pressure, a whole origin at a time; Safari deletes script-writable storage after seven days of use without a visit (which can't touch a 24-hour clip, but can the device keys); iOS Lockdown Mode disables IndexedDB. A card reviewed on another device has no audio at all.
- **The card is shared.** The inbox, the capture tray, and `/pilot` render the same `ProposalCard`, and WP8's scripted reviewer gates what a pilot card shows. The pilot's debriefs were written, never recorded.
- **Playback can happen while a debrief is live.** The tray reviews during capture, and a hands-free microphone hears the speakers.

## Considered options

- **The audio:** **the engine's own per-turn PCM16 at 16 kHz, recorded whenever clips or the witness need it (chosen)**; a MediaRecorder (its own start latency and clock, a container that differs by browser, a second encoder running during capture).
- **The format:** **raw PCM16, 32 kB a second (chosen)**; 8-bit μ-law at half the size; Opus through WebCodecs, 13–16× smaller but Safari 26+ only, and needing a decoder to play. About 3.2 MB per debrief and 48 MB for a heavy day fit every browser's quota, so size isn't worth a codec yet.
- **Where:** **IndexedDB, in a database of its own, `earshot-evidence`, under a key of its own (chosen)**; the device keys' database and key (clearing clips, on sign-out or when they're turned off, must never touch the keys, and one key would serve two purposes); Storage Buckets (Chromium-only); the Cache API (built for responses, not for small encrypted records with indexes).
- **At rest:** **AES-GCM under a non-extractable 256-bit key, with the record's own id as additional data (chosen)**; plaintext (anything that reads the profile reads the audio); additional data built from the record's fields (a record moved with its fields edited to match would still decrypt).
- **24 hours:** **never played after 24 hours, and deleted when Earshot next opens, comes back into view, writes a clip, or signs out (chosen)**; promising deletion at exactly 24 hours (nothing runs then); Storage Buckets' `expires`.
- **A turn too long to keep:** **a record with no audio (the encryption of nothing) that says the turn ran past the cap (chosen)**, so every no-audio line can be told apart later in the inbox; no record (indistinguishable from audio recorded elsewhere); a new field on the record (the spec fixes its shape).
- **Finding a span's clip:** **by the span's middle among the session's clips, on the audio clock (chosen)**; by turn id (cards don't carry one, and the inbox has no utterance-to-turn map); by the span's start (a hands-free turn's first word can sit just before its own clip's split).
- **Playing:** **Web Audio, one 16 kHz AudioBuffer holding the whole clip, the span by `start(0, offset, duration)` (chosen)**; an `<audio>` element on a WAV blob (seeking by `currentTime` is less exact, and the plaintext WAV lives at a blob URL until revoked).
- **Saying it's playing:** **one polite status line for the page, outside `<main>`, set once as a clip starts and emptied when it ends (chosen)**; the review toaster (a playback toast would replace a review's toast and its Undo, which ADR-0035 keeps one message per action for); `aria-pressed` (announces "pressed", not playing, and announces the end too); renaming the button while it plays (announced unreliably, and a toggle's name shouldn't change).
- **Playback during a live debrief:** **a hands-free engine takes no microphone audio while a clip plays, and pressing push-to-talk stops a clip (chosen)**; relying on echo cancellation (not guaranteed for audio the page plays); refusing to play during a debrief (another no-audio state, on the screen where the rep reviews first).
- **Turning clips off:** **stops keeping them and deletes the ones kept (chosen, the safer)**; keeps them until they expire (audio the rep asked not to keep would stay up to a day).
- **`persist()`:** **once, through WP3b's `earshot.persist.v1` flag, when the rep turns clips on (chosen)**; also when the first clip is kept under the default (Firefox asks the user, and its prompt would land mid-debrief; a device that debriefs has stored keys, which asked already).
- **A key for play:** **none (chosen)**: the spec gives none, and the inbox's single keys stay as WP5 defined them.

## Decision

### Recording (`apps/web/lib/capture/controller.ts`)

- The engine records turn audio when the witness runs or this device keeps clips: `turnAudio` is `witness.recordsAudio || clips.enabled()`, read as each engine starts.
- Each turn's `turn_audio`, from the running engine or one finishing its last turn as it stops, goes to `clips.keep({ sessionId, turnId, audio })` while clips are on (read again per turn, so turning them off mid-debrief stops at the next turn). A turn past the 120 s cap is kept as a too-long record; a turn with no audio of its own keeps nothing.
- The witness's own rule is unchanged: off, or no Groq key, sends no audio to Groq. Nothing in a message to `SessionDO` carries audio.
- While a clip plays on the page, a hands-free engine is muted (`isMuted`; muted frames are skipped by the speech stream and the recorder alike, so the clock stays one), and pressing push-to-talk stops the clip.
- The browser's sink (`browserClips`) writes fire-and-forget, and swallows a failure without logging it: not the error, which could name the session, and never the audio.

### The store (`packages/voice/src/evidence/clip-store.ts`)

- **IndexedDB `earshot-evidence`, version 1.** Two stores: `device`, the wrapping key, and `clips`, one record per turn, keyed `${sessionId}:${turnId}`, indexed on `sessionId` and `expiresAt`.
- **The record** is the spec's `ClipRecord`: `id`, `sessionId`, `turnId`, `startMs` (the audio clock), `durationMs`, `sampleRate: 16000`, `codec: "pcm16"`, `iv` (12 bytes), `data` (the encrypted PCM), `createdAt`, and `expiresAt = createdAt + 24 h`. A too-long record's `data` is AES-GCM of nothing, 16 bytes of tag; its `durationMs` is the turn's.
- **The key.** AES-GCM, 256 bits, generated non-extractable, stored as a `CryptoKey` (structured-cloneable, still non-extractable). It's made with the first clip kept, so a device that never keeps one never has one, in one transaction that keeps an existing key if another tab made one first. It's read from storage for each operation rather than held, so a tab that outlives another tab's clear writes under the key storage holds now.
- **The binding.** Additional data `earshot-clip:v1:<sessionId>:<turnId>`, built from where the record is stored. A record moved to another id fails to decrypt there; `find` deletes a record it can't decrypt, since it can never play. A record whose fields claim a session its id isn't in is ignored.
- **The API:** `put` (purges first), `find(sessionId, audioMs)` (the live clip covering that ms, decrypted, or null), `list(sessionId)` (the session's records without their audio, read one at a time, expired ones included so a card can say why), `purge(now)` (by the `expiresAt` index's keys, never reading the audio), and `clear()` (every record and the key). A write that began before a clear keeps nothing.

### 24 hours

- `find` never returns a clip whose `expiresAt` has passed, whether or not a purge has deleted it, and the player reads the clip from the store on every press, so nothing plays from memory.
- Expired records are deleted when the signed-in app opens (`EvidenceProvider` in `(app)/layout.tsx`), each time the page comes back into view (`visibilitychange` to visible), before each write, and at sign-out, which deletes everything. The cards' clock moves each minute, so a clip that expires while a card is on screen turns into its line.

### Playing a span (`clip-span.ts`, `clip-player.ts`)

- The sample is `(audioMs − startMs) × 16`. The span plays as `[a0 − 250 ms, a1 + 250 ms]`, clamped to the clip, from one 16 kHz AudioBuffer holding the whole clip (the context resamples it), with `source.start(0, offset, duration)`. One span plays at a time.
- The `AudioContext` is made, or resumed, synchronously in the click or key press that asked, before the store is read: autoplay rules leave a context made outside a gesture suspended.
- The button's name says the padded, clamped span in whole seconds, at least 1: "Play what you said, 2 seconds".

### The card (`apps/web/components/inbox/proposal-card.tsx`, `components/evidence/`)

- **A play button** after each field's heard words, and after the target's words where the card shows them: the mention line, or the first-person line when it speaks for the target. A loud line about a field leaves the target without a button; its fields still have theirs.
- **The button** is a real button, by pointer, Enter, or Space, with no single-key shortcut. Its name never changes. While its words play, its icon shows it (still, with reduced motion), and the page's status line says "Playing what you said." once; pressing it again plays the words again. If the clip has gone since the card rendered, the status line says why in the card's words, the card shows its line, and focus moves to the card rather than falling to the page.
- **One line per card** for what can't play, in the spec's words (a card's words come from one turn as a rule, so one reason covers them), checked in this order:

| State | Trigger | Line |
|---|---|---|
| Storage unavailable | The clip store won't open: no IndexedDB, as in iOS Lockdown Mode | "This browser can't keep audio." |
| Clips off | This device turned clips off in Settings → Capture | "Evidence clips are off. Turn them on in Settings → Capture." (a link) |
| Older than 24 hours | The clip covering the words is past its 24 hours; or there's none, and one would have expired by now (`startedAt + a1 + 24 h`) | "The audio was deleted after 24 hours." |
| Too long | The clip covering the words is a turn past 120 s, kept without audio | "That turn was too long to keep." |
| Another device | No clip covers the words, in a debrief this page didn't record | "No audio on this device. It stays where you recorded it." |

  On the capture screen's own debrief, a missing clip is pending, not elsewhere: nothing shows until it's kept.
- **The inbox and the tray** render `EvidenceCard`, which reads the session's clips through the page's `EvidenceHub` (one store and one player per page) and passes the card its `evidence`. A session whose clips would all have expired isn't read at all.
- **The pilot** renders `ProposalCard` with its own "no audio" line (`audioNote`), which rules out clips, and no `evidence`: a pilot card is unchanged, and never offers playback. WP8's reviewer and its KLM baseline are untouched.

### Settings, the notice, and `persist()`

- **Settings → Capture, "Evidence clips":** a switch, on by default, per device (`earshot.capture.clips` in localStorage), with the spec's sentence: "Keeps what you say on this device for 24 hours so you can replay it while reviewing. Never uploaded." Off stops keeping clips and deletes the ones kept, with their key, and says so. Where the browser can't keep audio, it says that and the switch stays off.
- **The notice** on the capture screen says clips are on, with the same sentence and a link to Settings → Capture, once per device: until it's dismissed, or a debrief starts with it on screen.
- **`persist()`:** turning clips on asks once, through WP3b's flag, so a browser already asked when a key was stored isn't asked again.

### Sign-out

The account menu's Sign out stops capture (so no turn of a running debrief is kept after), deletes every clip and the key, forgets the store's owner, then signs out, and signs out even if clearing fails (it waits at most 5 s). Deleting the account does the same, capture first.

**The store belongs to one user** (added after the automated security review of #62). `earshot.evidence.owner` in localStorage records the signed-in user it's kept for: a user id, never a name or email.
- **As the signed-in app opens,** a store recorded for anyone else, or for no one, is cleared before it's claimed. So the next user to sign in on a browser never inherits the last one's clips, however that session ended.
- **Before each write,** a page keeps a clip only while its viewer still owns the store.
- **Other tabs** hear the owner change as a `storage` event. They stop playing; a sign-out clears what's left, while another user's store is left to them.

### Never uploaded, and how that's held

- `@earshot/voice/evidence`, `apps/web/lib/evidence`, and `apps/web/components/evidence` contain no `fetch`, XMLHttpRequest, `sendBeacon`, WebSocket, `postMessage`, BroadcastChannel, server action, or `console` call; unit tests read their source and fail on any. No route under `app/api` touches clips (a test walks them).
- The end-to-end test records every request body and socket frame the page sends while a turn is recorded and played: none reaches 32 kB, a second of audio, against the turn's 65 kB clip, and no write goes anywhere named for clips. The session socket's messages are strict schemas with no field for audio, capped at 64 KiB.
- Nothing logs a clip, a sample, or a span: the sink swallows failures silently, and the player's and store's errors stay inside them.

### Tests

- `packages/voice/test/clip-store.test.ts` on memory and fake-indexeddb: round trips, ciphertext only, the non-extractable key, a record moved to another turn or session refused and deleted, never played after 24 hours before a purge, purges deleting only the expired (before each write too), the too-long record, a clear leaving no clip and no key and a later write under a new key, a write racing a clear keeping nothing, two pages agreeing on one key, the spec's database, stores, and indexes, and no IndexedDB refused.
- `clip-span.test.ts`: the sample formula, the padding in the middle, clamped at a clip's start, its end, and both, empty outside it. `clip-player.test.ts` on a fake context, and `test/browser/evidence.browser.test.ts` on Chromium's own IndexedDB, WebCrypto, and AudioContext.
- `apps/web/test/evidence.test.ts`: every state's trigger and line, the target's button placement, the hub's purges (at start and on coming back into view, not on hiding), reloads, play (readied in the gesture), announcement, missing clips, an unopenable store, sign-out's order and the store left empty. `capture-controller.test.ts`: clips recorded without a witness, nothing with clips off, turning them off mid-debrief, the witness's rule unchanged, and the mute and stop.
- `e2e/capture/evidence-clips.spec.ts` with the fake microphone: the notice, one turn kept as the spec's record, the play button, "Playing what you said." said once, nothing uploaded, and sign-out leaving no clip and no key. Stories for a card with clips, a loud card's target button, and every no-audio line, with axe.

## Consequences

**Good**

- A reviewer can hear the words behind a field, sample-exact, within the review, with no new provider, request, or server-side storage.
- The audio never reaches Earshot's servers, at rest it's encrypted under a key script can't read out, and it's gone within a day, at the latest at the next open.
- Every card works without audio, and says which of five reasons applies, so eviction, another device, or Lockdown Mode is a line, not a broken button.
- The pilot, and the gate WP8 holds on it, are untouched.

**Bad**

- Clips outlive their 24 hours on a device where Earshot isn't opened again: they're never played after it, but deleted only at the next open.
- An XSS on Earshot's origin could play clips, as it could use the device keys; there's no Content Security Policy until Phase 10.
- A sign-out that doesn't go through the account menu (a session that expires, or one signed out from another device) doesn't clear clips at once. They stay encrypted until Earshot next opens in that browser. Then they're deleted if they belong to anyone but the viewer, or expire within 24 hours if they're the viewer's own.
- A clip that couldn't be written (a full disk, a quota), and a debrief recorded here while clips were off, read later as "No audio on this device. It stays where you recorded it."
- The page has a second polite live region besides the toaster, against ADR-0035's single one, though it speaks only when a clip is pressed and sits outside `<main>`.
- On an iPhone, Web Audio follows the ring/silent switch, so a clip plays silently with it on silent (WebKit's `navigator.audioSession` could change that; it isn't used). WebKit also crackles audio played while an echo-cancelled microphone is live, which a clip in the tray during capture would be.
- Reading a session's clips for the cards reads their audio too (IndexedDB can't project fields), one record at a time; sessions whose clips would all have expired are skipped.
- Unverified on a device: Lockdown Mode's IndexedDB, iOS Safari under storage pressure, and playback on iOS (spec Appendix B, questions 5 and 6).

## More information

- Spec: `reports/Earshot Phase 5 build spec.md`, decision 6, the "24 hours in IndexedDB" row, §4.7, WP9, §7, and Appendix B. Research: `research_notes/Earshot Phase 5 tooling check/notes.md`, section 1.
- The store, span, and player: `packages/voice/src/evidence/`, exported as `@earshot/voice/evidence`.
- The web app: `apps/web/lib/evidence/{setting,copy,state,hub,browser}.ts`, `apps/web/components/evidence/`, `apps/web/components/inbox/proposal-card.tsx`, `apps/web/lib/capture/controller.ts`, `apps/web/app/(app)/settings/capture/page.tsx`, `apps/web/components/user-menu.tsx`.
- Related: ADR-0009 and ADR-0021 (the device keys' store, mirrored here with its own database and key), ADR-0029 (turn audio for the witness), ADR-0035 (the card, one message per action), ADR-0039 (the pilot and its scripted reviewer), and WP3b's `persist()` in `apps/web/lib/keys/device-storage.ts`.
