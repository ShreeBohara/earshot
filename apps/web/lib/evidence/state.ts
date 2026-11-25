// What a card can play (Phase 5 spec §4.7, WP9; ADR-0036), worked out from what's known, pure, so the
// tests read every state directly and the card only lays it out.
//
// A span of the card's words (the target's, or a field's `Evidence.audioMs`) is looked up by its
// middle among the session's clips on this device. Then, in order:
//
// | State | When | Card shows |
// |---|---|---|
// | unavailable | the clip store won't open: no IndexedDB, as in iOS Lockdown Mode | "This browser can't keep audio." |
// | clips_off | this device turned clips off (Settings → Capture) | "Evidence clips are off. Turn them on in Settings → Capture." |
// | pending | the session's clips are still loading, or the capture screen's own turn isn't kept yet | nothing yet |
// | expired | the clip covering it is past its 24 hours, or none is and one would have been by now | "The audio was deleted after 24 hours." |
// | too_long | the clip covering it is a turn that ran past 120 s, kept without audio | "That turn was too long to keep." |
// | another_device | no clip covers it, in a debrief this page didn't record | "No audio on this device. It stays where you recorded it." |
// | playable | a clip covers it and can play | a play button |
import { TARGET_FIELD } from "@earshot/core";
import {
  CLIP_TTL_MS,
  type ClipMeta,
  clipCovers,
  clipSpan,
  spanMiddle,
  spanSeconds,
} from "@earshot/voice/evidence";
import type { CardModel } from "@/lib/inbox/card";
import type { InboxProposal } from "@/lib/inbox/types";
import type { NoAudioReason } from "./copy";
import type { ClipsSetting } from "./setting";

/** A session's clips on this device, as the page has read them. */
export type ClipIndex =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly clips: readonly ClipMeta[] };

/** The debrief a card belongs to, as far as its clips go. */
export interface EvidenceSession {
  readonly sessionId: string;
  readonly startedAt: string;
  /** Null while it's live. */
  readonly endedAt: string | null;
  /**
   * The capture screen's own debrief, recorded by this page: a turn it hasn't kept yet is on its
   * way, never on another device.
   */
  readonly recordedHere: boolean;
}

export interface EvidenceInputs {
  readonly setting: ClipsSetting;
  readonly index: ClipIndex;
  readonly session: EvidenceSession;
  /** Epoch ms. */
  readonly now: number;
}

export type SpanState =
  | { readonly kind: "playable"; readonly clip: ClipMeta; readonly seconds: number }
  | { readonly kind: "pending" }
  | { readonly kind: NoAudioReason };

/** The clip covering `ms`, the latest kept if two do. */
function covering(clips: readonly ClipMeta[], ms: number): ClipMeta | undefined {
  let best: ClipMeta | undefined;
  for (const clip of clips) {
    if (clipCovers(clip, ms) && (!best || clip.createdAt > best.createdAt)) best = clip;
  }
  return best;
}

/**
 * Whether a clip of these words would be past its 24 hours by now, had this device kept one. The
 * turn ended no sooner than its words did on the session's clock, which runs no faster than the
 * wall clock from the start, so its clip expired no sooner than `startedAt + a1 + 24 h`.
 */
export function wouldHaveExpired(
  session: Pick<EvidenceSession, "startedAt">,
  audioMs: readonly [number, number],
  now: number,
): boolean {
  const startedAt = Date.parse(session.startedAt);
  if (Number.isNaN(startedAt)) return false;
  return startedAt + Math.max(audioMs[0], audioMs[1]) + CLIP_TTL_MS <= now;
}

/** Whether every clip a session could have kept is past its 24 hours: nothing there to read. */
export function sessionClipsExpired(
  session: Pick<EvidenceSession, "startedAt" | "endedAt">,
  now: number,
): boolean {
  if (session.endedAt === null) return false;
  const endedAt = Date.parse(session.endedAt);
  return !Number.isNaN(endedAt) && endedAt + CLIP_TTL_MS <= now;
}

/** What one span of a card's words can do now. */
export function spanState(inputs: EvidenceInputs, audioMs: readonly [number, number]): SpanState {
  const { index, session, now } = inputs;
  if (index.status === "unavailable") return { kind: "unavailable" };
  if (inputs.setting === "off") return { kind: "clips_off" };
  if (index.status === "loading") return { kind: "pending" };
  const clip = covering(index.clips, spanMiddle(audioMs));
  if (clip) {
    if (clip.expiresAt <= now) return { kind: "expired" };
    if (clip.samples === 0) return { kind: "too_long" };
    const span = clipSpan(clip, audioMs);
    if (span.end <= span.start) return { kind: "another_device" };
    return { kind: "playable", clip, seconds: spanSeconds(span) };
  }
  if (wouldHaveExpired(session, audioMs, now)) return { kind: "expired" };
  return session.recordedHere ? { kind: "pending" } : { kind: "another_device" };
}

/**
 * Where a card shows the target's words, so its play button has a place: the mention line, or the
 * first-person line when it speaks for the target. Nowhere when the card shows neither (a loud
 * line about a field, or a target no one named): then only its fields play.
 */
export function targetWords(
  model: Pick<CardModel, "mention" | "firstPerson">,
): "mention" | "first_person" | null {
  if (model.mention === null) return null;
  if (!model.firstPerson) return "mention";
  const { field } = model.firstPerson;
  return field === null || field === TARGET_FIELD ? "first_person" : null;
}

/** One span a card can play: its control's key, where its words are, and how long it plays. */
export interface PlayableSpan {
  /** `${proposalId}:${field}`, or `:target`: the player says which control is playing. */
  readonly key: string;
  readonly sessionId: string;
  readonly audioMs: readonly [number, number];
  /** The padded, clamped span in whole seconds: the button's name says it. */
  readonly seconds: number;
}

/** What a card can play, and the one line saying why the rest can't. */
export interface CardEvidence {
  /** The target's words, when the card shows them and they can play. */
  readonly target: PlayableSpan | null;
  /** Each field whose words can play, by field name. */
  readonly fields: Readonly<Record<string, PlayableSpan>>;
  /** Why some of the card's words can't play, from the first that can't; null when all can. */
  readonly note: NoAudioReason | null;
}

/**
 * A card's evidence: a span for the target's words when the card shows them (`targetShown`), and
 * one for each field. A card shows a single line for what can't play: its words come from one turn
 * as a rule, so one reason covers them.
 */
export function cardEvidence(
  inputs: EvidenceInputs,
  proposal: Pick<InboxProposal, "proposalId" | "target" | "fields">,
  targetShown: boolean,
): CardEvidence {
  const spans: { readonly name: string; readonly audioMs: readonly [number, number] }[] = [];
  const mention = proposal.target.mention;
  if (targetShown && mention) spans.push({ name: TARGET_FIELD, audioMs: mention.evidence.audioMs });
  for (const [name, field] of Object.entries(proposal.fields)) {
    spans.push({ name, audioMs: field.evidence.audioMs });
  }
  let target: PlayableSpan | null = null;
  const fields: Record<string, PlayableSpan> = {};
  let note: NoAudioReason | null = null;
  for (const span of spans) {
    const state = spanState(inputs, span.audioMs);
    if (state.kind === "playable") {
      const play: PlayableSpan = {
        key: `${proposal.proposalId}:${span.name}`,
        sessionId: inputs.session.sessionId,
        audioMs: span.audioMs,
        seconds: state.seconds,
      };
      if (span.name === TARGET_FIELD) target = play;
      else fields[span.name] = play;
    } else if (state.kind !== "pending") {
      note ??= state.kind;
    }
  }
  return { target, fields, note };
}
