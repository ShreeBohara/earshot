// /demo's replay over time (spec WP10). A recorded session log is played back into a
// `SessionStore`, the store the capture screen subscribes to, so the replay renders through the
// capture components and folds every event with the same registry and projections as the live
// screen and Postgres. Each event lands at its offset from `session.started`, by `ts`. Utterances
// with word timings arrive word by word first, as the live partial does; the others appear whole.
// The orb's microphone level is synthesized from the words' timing. The clock is injected, so
// tests drive the replay by hand. Nothing here touches a key, the edge Worker, or a provider.
import type { EntityRef, EventEnvelope, ProposalTypeV2 } from "@earshot/core";
import { defaultRegistry } from "@earshot/events";
import type { Clock } from "@earshot/voice";
import { type SessionState, SessionStore } from "@earshot/voice/session";
import type { ActivityRow } from "@/lib/capture/activity";
import { PROPOSAL_TYPE_LABELS, turnOutcomeText } from "@/lib/capture/copy";
import { LevelMeter } from "@/lib/capture/levels";

/** The speeds readers get. */
export const REPLAY_SPEEDS = [1, 2] as const;
/** For tests only: `/demo?speed=8` shows it (and starts there). */
export const TEST_SPEED = 8;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number] | typeof TEST_SPEED;

/**
 * The session records the demo session's `start` carried: Acme Corp, its deal, and look-alikes
 * from the demo CRM (`@earshot/agent/testing`'s `DEMO_ENTITIES`). The log doesn't record them,
 * and the transcript needs them for mentions and the tray for each proposal's target.
 */
export const DEMO_ENTITIES: readonly EntityRef[] = [
  {
    id: "01a0f831-ac00-75a0-a2b2-cb79eb1835bf",
    kind: "company",
    name: "Acme Corp",
    aliases: ["Acme"],
  },
  {
    id: "01a0f831-afe8-7fff-84cf-71639949085b",
    kind: "deal",
    name: "Acme Corp - Security Platform",
    aliases: [],
  },
  { id: "co_044", kind: "company", name: "Akme Dynamics", aliases: ["Akme"] },
  { id: "co_040", kind: "company", name: "Acmi Dynamics", aliases: ["Acmi"] },
  { id: "ct_112", kind: "contact", name: "Donna Lee", aliases: [] },
  { id: "ct_145", kind: "contact", name: "Dana Li", aliases: [] },
];

/** Something the replay does at a moment of session time: ms from `session.started`. */
export type ReplayCue =
  | {
      readonly at: number;
      readonly kind: "event";
      readonly event: EventEnvelope;
      /** For `utterance.final`: the utterance it finishes, whose partial it replaces. */
      readonly utteranceId: string | null;
    }
  | {
      readonly at: number;
      readonly kind: "words";
      readonly utteranceId: string;
      /** The words heard so far, as the live partial shows them. */
      readonly text: string;
    };

/** One word's voice, for the orb: when it starts and ends, and how loud it peaks (0 to 1). */
export interface VoicedWord {
  readonly start: number;
  readonly end: number;
  readonly peak: number;
}

/** One utterance's speech, from its first word to its last. */
export interface SpeechSpan {
  readonly start: number;
  readonly end: number;
}

export interface ReplayTimeline {
  readonly sessionId: string;
  /** In the order they happen; cues at the same moment keep the log's order. */
  readonly cues: readonly ReplayCue[];
  /** By start. */
  readonly words: readonly VoicedWord[];
  /** By start. */
  readonly spans: readonly SpeechSpan[];
  /** The last event's offset. */
  readonly durationMs: number;
}

/** The level between words inside an utterance: breath, not silence. */
const MURMUR = 0.06;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Words spread over an utterance without timings, by length, for the orb only (never shown). */
function estimateWords(text: string, start: number, end: number) {
  const weights = text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.length + 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const length = Math.max(0, end - start);
  let cursor = start;
  return weights.map((weight) => {
    const slot = (length * weight) / total;
    const voiced = { start: cursor, end: cursor + slot * 0.8 };
    cursor += slot;
    return voiced;
  });
}

/**
 * The replay's timeline from a session log (as `fromJsonl` reads it): every event at its offset
 * from `session.started` by `ts`, never earlier than the event before it (the store folds in seq
 * order), and the words of each timed utterance at the moments they were heard. Word timings are
 * audio time, from `session.started`'s `startedAt`.
 */
export function buildReplayTimeline(log: readonly EventEnvelope[]): ReplayTimeline {
  const events = [...log].sort((a, b) => a.seq - b.seq);
  const first = events[0];
  if (first?.type !== "session.started") {
    throw new Error("A replay needs a log that opens with session.started");
  }
  const origin = Date.parse(first.ts);
  const started = defaultRegistry.toLatest(first);
  const audioOrigin =
    started.type === "session.started" ? Date.parse(started.payload.startedAt) - origin : 0;

  const cues: ReplayCue[] = [];
  const words: VoicedWord[] = [];
  const spans: SpeechSpan[] = [];
  let last = 0;
  for (const envelope of events) {
    const at = Math.max(last, Date.parse(envelope.ts) - origin);
    last = at;
    const event = defaultRegistry.toLatest(envelope);
    if (event.type !== "utterance.final") {
      cues.push({ at, kind: "event", event: envelope, utteranceId: null });
      continue;
    }
    const { utteranceId, text, startMs, endMs } = event.payload;
    // A word shows once it has been said, and no later than its utterance's final.
    const timed = (event.payload.words ?? []).map((word) => ({
      text: word.w,
      start: clamp(audioOrigin + word.startMs, 0, at),
      end: clamp(audioOrigin + word.endMs, 0, at),
    }));
    let heard = "";
    for (const word of timed) {
      heard = heard ? `${heard} ${word.text}` : word.text;
      cues.push({ at: word.end, kind: "words", utteranceId, text: heard });
    }
    const voice =
      timed.length > 0
        ? timed
        : estimateWords(
            text,
            clamp(audioOrigin + startMs, 0, at),
            clamp(audioOrigin + endMs, 0, at),
          );
    for (const word of voice) {
      // Longer words carry more voice; short ones barely lift the orb.
      const peak = 0.35 + 0.4 * Math.min(1, (word.end - word.start) / 500);
      words.push({ start: word.start, end: word.end, peak });
    }
    const firstWord = voice[0];
    const lastWord = voice.at(-1);
    if (firstWord && lastWord) spans.push({ start: firstWord.start, end: lastWord.end });
    cues.push({ at, kind: "event", event: envelope, utteranceId });
  }
  // Stable: an utterance's words stay ahead of its final, and events keep their seq order.
  cues.sort((a, b) => a.at - b.at);
  words.sort((a, b) => a.start - b.start);
  spans.sort((a, b) => a.start - b.start);
  return { sessionId: first.sessionId, cues, words, spans, durationMs: last };
}

/** The synthesized microphone level at `position`: a swell over each word, a murmur between. */
export function micLevelAt(
  timeline: Pick<ReplayTimeline, "words" | "spans">,
  position: number,
): number {
  if (!timeline.spans.some((span) => position >= span.start && position < span.end)) return 0;
  let level = MURMUR;
  for (const word of timeline.words) {
    if (word.start > position) break;
    if (position < word.end) {
      const t = (position - word.start) / Math.max(1, word.end - word.start);
      level = Math.max(level, word.peak * Math.sin(Math.PI * t));
    }
  }
  return Math.round(level * 100) / 100;
}

export type ReplayStatus = "ready" | "playing" | "paused" | "ended";

/** What the replay screen shows. A new object on every visible change, so it can be a snapshot. */
export interface ReplayView {
  readonly status: ReplayStatus;
  readonly speed: ReplaySpeed;
  /** Session time, ms from `session.started`. While playing it moves on in whole seconds. */
  readonly positionMs: number;
  readonly durationMs: number;
  /** The words of the utterance being heard: the live partial. */
  readonly partial: string | null;
  /** This run's store. A restart makes a new one: nothing outlives its run. */
  readonly store: SessionStore;
  /** How many events this run has folded. */
  readonly applied: number;
}

export interface ReplayDriverOptions {
  readonly clock?: Clock;
  readonly speed?: ReplaySpeed;
  /** How often the orb's level moves while someone speaks, in wall-clock ms. */
  readonly levelTickMs?: number;
}

/** Looks the globals up on every call, like `@earshot/voice`'s `systemClock`. */
const platformClock: Clock = {
  now: () => globalThis.performance.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Session time tolerated as "now", so float rounding never leaves a cue a hair short of due. */
const EPSILON = 0.01;

/**
 * Plays a timeline into a `SessionStore` over time. One timer at a time, for the next thing that
 * changes: a cue, the next whole second, or the orb's next level while someone speaks. Pausing
 * holds the position; speed changes keep it; skipping to the end folds the rest at once; a
 * restart starts over with a new store. `subscribe` and `getView` fit `useSyncExternalStore`.
 */
export class ReplayDriver {
  readonly timeline: ReplayTimeline;
  /** The orb's levels. Never through React state. */
  readonly levels = new LevelMeter();
  readonly #clock: Clock;
  readonly #levelTickMs: number;
  readonly #listeners = new Set<() => void>();
  #store: SessionStore;
  #status: ReplayStatus = "ready";
  #speed: ReplaySpeed;
  #cursor = 0;
  #applied = 0;
  #partial: { readonly utteranceId: string; readonly text: string } | null = null;
  /** Session time at `#anchorWall`, while playing; the held position otherwise. */
  #position = 0;
  #anchorWall = 0;
  #timer: unknown = null;
  #view: ReplayView;

  constructor(timeline: ReplayTimeline, options: ReplayDriverOptions = {}) {
    this.timeline = timeline;
    this.#clock = options.clock ?? platformClock;
    this.#speed = options.speed ?? 1;
    this.#levelTickMs = options.levelTickMs ?? 33;
    this.#store = new SessionStore(timeline.sessionId);
    this.#view = this.#makeView();
  }

  readonly getView = (): ReplayView => this.#view;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Where the replay is right now, in session time. */
  position(): number {
    if (this.#status !== "playing") return this.#position;
    const elapsed = (this.#clock.now() - this.#anchorWall) * this.#speed;
    return Math.min(this.timeline.durationMs, this.#position + elapsed);
  }

  play(): void {
    if (this.#status === "playing") return;
    if (this.#status === "ended") {
      this.restart();
      return;
    }
    this.#status = "playing";
    this.#anchorWall = this.#clock.now();
    this.#advance();
  }

  pause(): void {
    if (this.#status !== "playing") return;
    const position = this.position();
    this.#clearTimer();
    this.#applyDue(position);
    this.#position = position;
    this.#status = "paused";
    this.levels.set(0, 0);
    this.#emit();
  }

  toggle(): void {
    if (this.#status === "playing") this.pause();
    else this.play();
  }

  setSpeed(speed: ReplaySpeed): void {
    if (speed === this.#speed) return;
    if (this.#status !== "playing") {
      this.#speed = speed;
      this.#emit();
      return;
    }
    this.#position = this.position();
    this.#anchorWall = this.#clock.now();
    this.#speed = speed;
    this.#advance();
  }

  /** Folds everything left at once and stops at the end. */
  skipToEnd(): void {
    if (this.#status === "ended") return;
    this.#applyDue(Number.POSITIVE_INFINITY);
    this.#finish();
  }

  /** Starts over from the first event, with a new store, and plays. */
  restart(): void {
    this.#clearTimer();
    this.#store = new SessionStore(this.timeline.sessionId);
    this.#cursor = 0;
    this.#applied = 0;
    this.#partial = null;
    this.#position = 0;
    this.#status = "playing";
    this.#anchorWall = this.#clock.now();
    this.#advance();
  }

  /** Stops the timer (pausing a replay that plays). The driver still works afterwards. */
  dispose(): void {
    this.pause();
    this.#clearTimer();
  }

  /**
   * Folds what's due, moves the orb, and sets the timer for the next change. It replaces any timer
   * already set (a speed change calls it mid-wait), so only one ever runs, and never while stopped.
   */
  #advance(): void {
    this.#clearTimer();
    if (this.#status !== "playing") return;
    const position = this.position();
    this.#applyDue(position);
    if (this.#cursor >= this.timeline.cues.length) {
      this.#finish();
      return;
    }
    this.#position = position;
    this.#anchorWall = this.#clock.now();
    this.levels.set(micLevelAt(this.timeline, position), 0);
    this.#emit();

    // Every candidate lies past `now`, so no timer is ever set for a moment already handled.
    const now = position + EPSILON;
    let next = this.timeline.cues[this.#cursor]?.at ?? this.timeline.durationMs;
    next = Math.min(next, (Math.floor(now / 1000) + 1) * 1000);
    // While someone speaks the orb moves every tick; the tick after their last word brings it to
    // 0. Between utterances the next one's first word is the next change.
    const span = this.timeline.spans.find((candidate) => candidate.end > position);
    if (span && span.start <= now)
      next = Math.min(next, position + this.#levelTickMs * this.#speed);
    else if (span) next = Math.min(next, span.start);
    const delay = Math.max(0, (next - position) / this.#speed);
    this.#timer = this.#clock.setTimeout(() => this.#advance(), delay);
  }

  #applyDue(position: number): void {
    const due = position + EPSILON;
    const { cues } = this.timeline;
    while (this.#cursor < cues.length) {
      const cue = cues[this.#cursor];
      if (!cue || cue.at > due) break;
      this.#cursor += 1;
      if (cue.kind === "words") {
        this.#partial = { utteranceId: cue.utteranceId, text: cue.text };
        continue;
      }
      // Session time stands in for the arrival time, so every run folds the same state.
      this.#store.applyEvent(cue.event, cue.at);
      this.#applied += 1;
      if (cue.utteranceId !== null && this.#partial?.utteranceId === cue.utteranceId) {
        this.#partial = null;
      }
    }
  }

  #finish(): void {
    this.#clearTimer();
    this.#status = "ended";
    this.#position = this.timeline.durationMs;
    this.#partial = null;
    this.levels.set(0, 0);
    this.#emit();
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #makeView(): ReplayView {
    return {
      status: this.#status,
      speed: this.#speed,
      positionMs: this.#position,
      durationMs: this.timeline.durationMs,
      partial: this.#partial?.text ?? null,
      store: this.#store,
      applied: this.#applied,
    };
  }

  /** A new view when something visible changed: the second shown counts, finer moves don't. */
  #emit(): void {
    const view = this.#makeView();
    const before = this.#view;
    const second = (ms: number) => Math.floor((ms + EPSILON) / 1000);
    if (
      view.status === before.status &&
      view.speed === before.speed &&
      view.partial === before.partial &&
      view.store === before.store &&
      view.applied === before.applied &&
      second(view.positionMs) === second(before.positionMs)
    ) {
      return;
    }
    this.#view = view;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A subscriber's bug mustn't stop the replay.
      }
    }
  }
}

const REVIEW_TEXT = {
  approved: (label: string) => `Review: approved the ${label}.`,
  edited: (label: string) => `Review: edited the ${label}, then approved it.`,
  rejected: (label: string) => `Review: rejected the ${label}.`,
} as const;

/**
 * The replay's own feed rows: each proposal as it arrives (the live feed says so from
 * `turn.completed`, which this log predates) and each review decision after the call. Rows sit at
 * their event's session time, among the session's own rows.
 */
export function replayActivity(state: SessionState): ActivityRow[] {
  const turns = state.events.some((event) => event.type === "turn.completed");
  const types = new Map<string, ProposalTypeV2>();
  const rows: ActivityRow[] = [];
  state.events.forEach((event, index) => {
    const at = state.receivedAt[index] ?? 0;
    if (event.type === "proposal.created") {
      types.set(event.payload.proposalId, event.payload.type);
      if (turns) return;
      const text = turnOutcomeText("proposals", [event.payload.type]);
      rows.push({ id: `replay-${event.id}`, kind: "response", text, at });
    } else if (event.type === "proposal.reviewed") {
      const type = types.get(event.payload.proposalId);
      const label = type ? PROPOSAL_TYPE_LABELS[type].toLowerCase() : "proposal";
      rows.push({
        id: `replay-${event.id}`,
        kind: "action",
        text: REVIEW_TEXT[event.payload.decision](label),
        at,
      });
    }
  });
  return rows;
}
