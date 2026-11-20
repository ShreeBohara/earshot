// The second witness's side of a session (Phase 4 spec WP9 step 3; ADR-0029). Once a turn's
// `turn_end` is queued, it runs the witness on that turn's audio, in parallel with SessionDO's
// extraction, and sends what came back through the outbox: a `witness` message, and on a
// transcript a `usage` message for the cost meter (the Groq row bills audio, 10 s at least).
//
// - Witness messages go out in turn order, whatever order the provider answers in, so SessionDO
//   compares turns in order too. A turn waits for the one before it, never longer than that turn's
//   request: each attempt times out at 10 s.
// - A turn sends nothing when the witness has nothing to work with: no audio of its own, under
//   1 s of it (a tap; Whisper invents text on near-silence and bills 10 s anyway), or nothing the
//   biased stream heard (SessionDO would have no window to check it against, and no proposal).
// - Otherwise every turn gets a message: the transcript; `skipped` with `off`, `no_key`, or
//   `too_long`; or `failed` with the provider's `rate_limited`, `provider_error`, or `timeout`.
// - The transcript keeps only the words within 0.9 s of the turn's own words, so SessionDO's 1 s
//   window check can't refuse it for a word Whisper heard in the release's tail or invented in
//   the silence there; and it's fitted to the socket's text and frame caps.
import {
  MAX_MESSAGE_BYTES,
  MAX_UTTERANCE_TEXT_CHARS,
  type UtteranceFinalV2,
  type WitnessReason,
} from "@earshot/core";
import { type Clock, systemClock } from "../stt/socket";
import {
  MIN_WITNESS_AUDIO_MS,
  type UnbiasedUtterance,
  type WitnessRunner,
} from "../witness/runner";
import type { TurnAudio } from "../witness/turn-audio";
import type { SendUsageInput, SendWitnessInput, SessionClient, SessionLog } from "./client";

/** The witness a session runs, or why it runs none. */
export type WitnessSetup =
  | { readonly status: "on"; readonly runner: WitnessRunner }
  | {
      /** `off`: the rep hasn't turned it on (or has no Groq key). `no_key`: on, but no key here. */
      readonly status: "off" | "no_key";
      /** The witness the turn would have had, for `turn.witnessed`. */
      readonly provider: string;
      readonly model: string;
    };

/** How far the witness's words may sit outside the turn's own words, in ms: under SessionDO's 1 s. */
export const WITNESS_WINDOW_MARGIN_MS = 900;

/** How long a turn's audio may take to follow its `turn_end` before the turn is let go. */
export const TURN_AUDIO_WAIT_MS = 15_000;

/** The most an unbiased utterance may take of a `witness` frame, leaving room for the rest. */
const MAX_UTTERANCE_BYTES = MAX_MESSAGE_BYTES - 1_024;

export interface SessionWitnessOptions {
  readonly client: Pick<SessionClient, "sendWitness" | "sendUsage">;
  /** The witness this session runs, read once per turn, at its end. */
  readonly setup: () => WitnessSetup;
  readonly clock?: Clock;
  readonly audioWaitMs?: number;
  readonly log?: SessionLog;
}

type Outgoing =
  | { readonly t: "witness"; readonly input: SendWitnessInput }
  | { readonly t: "usage"; readonly input: SendUsageInput };

interface TurnState {
  readonly turnId: string;
  /** The biased stream's words in this turn, as a span of the session's clock. */
  window: { startMs: number; endMs: number } | null;
  /** Undefined until the engine's `turn_audio`. */
  audio: TurnAudio | null | undefined;
  setup: WitnessSetup | null;
  /** Its `turn_end` didn't go out (no LLM key): nothing more is sent for it. */
  dropped: boolean;
  started: boolean;
  settle: ((messages: readonly Outgoing[]) => void) | null;
  timer: unknown;
}

const SILENT_LOG: SessionLog = { debug: () => {} };

export class SessionWitness {
  readonly #client: SessionWitnessOptions["client"];
  readonly #setup: () => WitnessSetup;
  readonly #clock: Clock;
  readonly #audioWaitMs: number;
  readonly #log: SessionLog;
  readonly #turns = new Map<string, TurnState>();
  readonly #abort = new AbortController();
  /** Every turn's messages so far, sent in turn order. */
  #tail: Promise<void> = Promise.resolve();

  constructor(options: SessionWitnessOptions) {
    this.#client = options.client;
    this.#setup = options.setup;
    this.#clock = options.clock ?? systemClock;
    this.#audioWaitMs = options.audioWaitMs ?? TURN_AUDIO_WAIT_MS;
    this.#log = options.log ?? SILENT_LOG;
  }

  /** Whether the engine should keep each turn's audio: only for a witness that runs. */
  get recordsAudio(): boolean {
    return this.#setup().status === "on";
  }

  /** A biased final of the turn: it widens the turn's window. */
  finalHeard(turnId: string, utterance: Pick<UtteranceFinalV2, "startMs" | "endMs">): void {
    const turn = this.#turn(turnId);
    turn.window = turn.window
      ? {
          startMs: Math.min(turn.window.startMs, utterance.startMs),
          endMs: Math.max(turn.window.endMs, utterance.endMs),
        }
      : { startMs: utterance.startMs, endMs: utterance.endMs };
  }

  /** The turn's `turn_end` is in the outbox: its witness runs now, or as soon as its audio is in. */
  turnEnded(turnId: string): void {
    const turn = this.#turn(turnId);
    if (turn.setup || turn.dropped || this.#abort.signal.aborted) return;
    const setup = this.#setup();
    turn.setup = setup;
    const slot = new Promise<readonly Outgoing[]>((resolve) => {
      turn.settle = resolve;
    });
    this.#tail = this.#tail.then(async () => this.#send(await slot));
    if (setup.status !== "on") {
      this.#finish(turn, [this.#skipped(turnId, setup, setup.status)]);
      return;
    }
    if (turn.audio !== undefined) this.#run(turn, setup.runner);
    else {
      turn.timer = this.#clock.setTimeout(() => {
        this.#log.debug("witness skipped", { reason: "no_audio" });
        this.#finish(turn, []);
      }, this.#audioWaitMs);
    }
  }

  /** The turn's `turn_end` never went out: its witness is never sent either. */
  turnDropped(turnId: string): void {
    const turn = this.#turn(turnId);
    turn.dropped = true;
    if (!turn.setup) this.#turns.delete(turnId);
  }

  /** The engine's `turn_audio`: the turn's audio, or null for a turn with none of its own. */
  turnAudio(turnId: string, audio: TurnAudio | null): void {
    const turn = this.#turns.get(turnId);
    if (!turn || turn.dropped) return;
    turn.audio = audio;
    if (turn.setup?.status === "on") this.#run(turn, turn.setup.runner);
  }

  /** Resolves once every witness so far has gone to the outbox: wait for it before `end`. */
  idle(): Promise<void> {
    return this.#tail;
  }

  /** The session is over: requests in flight are abandoned and nothing more is sent. */
  dispose(): void {
    this.#abort.abort();
    for (const turn of [...this.#turns.values()]) this.#finish(turn, []);
    this.#turns.clear();
  }

  #turn(turnId: string): TurnState {
    let turn = this.#turns.get(turnId);
    if (!turn) {
      turn = {
        turnId,
        window: null,
        audio: undefined,
        setup: null,
        dropped: false,
        started: false,
        settle: null,
        timer: undefined,
      };
      this.#turns.set(turnId, turn);
    }
    return turn;
  }

  #run(turn: TurnState, runner: WitnessRunner): void {
    if (turn.started || turn.audio === undefined) return;
    turn.started = true;
    this.#clock.clearTimeout(turn.timer);
    const { audio, window } = turn;
    if (audio === null || audio.durationMs < MIN_WITNESS_AUDIO_MS || window === null) {
      // No audio of its own, a tap, or nothing the biased stream heard: nothing to compare.
      this.#log.debug("witness not sent", {
        reason: audio === null ? "no_audio" : window === null ? "silent" : "short",
      });
      this.#finish(turn, []);
      return;
    }
    const source = { provider: runner.provider, model: runner.model };
    if (audio.pcm === null) {
      this.#finish(turn, [this.#skipped(turn.turnId, source, "too_long")]);
      return;
    }
    const signal = this.#abort.signal;
    void runner
      .transcribe(audio.pcm, { turnStartMs: audio.startMs, signal })
      .then((result) => {
        if (signal.aborted) return this.#finish(turn, []);
        if (!("utterance" in result)) {
          const outcome = result.failure === "no_key" ? "skipped" : "failed";
          this.#log.debug("witness answered", { outcome, reason: result.failure });
          return this.#finish(turn, [
            {
              t: "witness",
              input: {
                turnId: turn.turnId,
                ...source,
                outcome,
                reason: result.failure,
                latencyMs: result.latencyMs,
              },
            },
          ]);
        }
        const utterance = fitWitnessUtterance(result.utterance, window);
        const usage: Outgoing = {
          t: "usage",
          input: { ...source, audioMs: result.audioMs, socketMs: 0 },
        };
        if (!utterance) {
          // Every word fell outside the turn's words: there's nothing to compare, though the
          // provider was paid for the audio.
          this.#log.debug("witness answered", { outcome: "transcribed", words: 0 });
          return this.#finish(turn, [usage]);
        }
        this.#log.debug("witness answered", {
          outcome: "transcribed",
          words: utterance.words?.length ?? 0,
        });
        return this.#finish(turn, [
          {
            t: "witness",
            input: {
              turnId: turn.turnId,
              ...source,
              outcome: "transcribed",
              utterance,
              latencyMs: result.latencyMs,
            },
          },
          usage,
        ]);
      })
      .catch(() => {
        // A runner never throws; one that did can't hold up the turns after it.
        this.#finish(turn, []);
      });
  }

  #skipped(
    turnId: string,
    source: { readonly provider: string; readonly model: string },
    reason: Extract<WitnessReason, "off" | "no_key" | "too_long">,
  ): Outgoing {
    return {
      t: "witness",
      input: { turnId, provider: source.provider, model: source.model, outcome: "skipped", reason },
    };
  }

  #finish(turn: TurnState, messages: readonly Outgoing[]): void {
    this.#clock.clearTimeout(turn.timer);
    const settle = turn.settle;
    turn.settle = null;
    this.#turns.delete(turn.turnId);
    settle?.(this.#abort.signal.aborted ? [] : messages);
  }

  #send(messages: readonly Outgoing[]): void {
    if (this.#abort.signal.aborted) return;
    for (const message of messages) {
      if (message.t === "witness") this.#client.sendWitness(message.input);
      else this.#client.sendUsage(message.input);
    }
  }
}

/** UTF-8 bytes of a value's JSON, counted without encoding it. */
function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value);
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit < 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** `text` cut to at most `max` UTF-16 units, at the last space if there's one. */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).trim();
}

/**
 * The witness's transcript as a `witness` message can carry it (and SessionDO will take it):
 * - only the words within `WITNESS_WINDOW_MARGIN_MS` of the turn's own words, with the text
 *   rebuilt from them when any went, and its span from what's left; null when none is left;
 * - without word timings, its span kept inside the same bounds;
 * - its text within the socket's 4,000 characters, the words cut with it;
 * - its words dropped altogether if they'd overflow the 64 KiB frame: alignment still reads it.
 */
export function fitWitnessUtterance(
  utterance: UnbiasedUtterance,
  window: { readonly startMs: number; readonly endMs: number },
): UnbiasedUtterance | null {
  const lo = Math.max(0, window.startMs - WITNESS_WINDOW_MARGIN_MS);
  const hi = window.endMs + WITNESS_WINDOW_MARGIN_MS;
  let fitted: UnbiasedUtterance = utterance;
  const words = utterance.words;
  if (words && words.length > 0) {
    let kept = words.filter((word) => word.startMs >= lo && word.endMs <= hi);
    if (kept.length === 0) return null;
    let text = kept.length === words.length ? utterance.text : kept.map((w) => w.w).join(" ");
    if (text.length > MAX_UTTERANCE_TEXT_CHARS) {
      // Rebuilt from the words, as many as fit.
      const fits: typeof kept = [];
      let length = -1;
      for (const word of kept) {
        if (length + 1 + word.w.length > MAX_UTTERANCE_TEXT_CHARS) break;
        fits.push(word);
        length += 1 + word.w.length;
      }
      kept = fits;
      text = fits.map((w) => w.w).join(" ");
    }
    const first = kept[0];
    const last = kept.at(-1);
    if (!first || !last || text.trim() === "") return null;
    fitted = { ...utterance, text, words: kept, startMs: first.startMs, endMs: last.endMs };
  } else {
    const text = cutText(utterance.text, MAX_UTTERANCE_TEXT_CHARS);
    if (text === "") return null;
    const startMs = Math.min(Math.max(utterance.startMs, lo), hi);
    fitted = {
      ...utterance,
      text,
      startMs,
      endMs: Math.min(Math.max(utterance.endMs, startMs), hi),
    };
  }
  if (fitted.words && jsonBytes(fitted) > MAX_UTTERANCE_BYTES) {
    const { words: _dropped, ...rest } = fitted;
    fitted = rest;
  }
  return fitted;
}
