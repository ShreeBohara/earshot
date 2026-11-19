// The fake speech-to-text adapter (spec WP4 step 4): deterministic, offline, and free, for unit
// tests, `pnpm dev` without keys, and WP11's fake-microphone end-to-end runs in CI.
//
// It never looks at the audio. It counts the samples it receives, which is the session's audio
// clock, and emits a script's words as the clock passes them: a partial whenever another word has
// been heard, then a final and an end of turn, either at once on `finalize()` or after its own
// endpointing delay. A word counts as heard only once every sample under it has arrived on some
// socket, so audio lost in a socket drop and never replayed shows up as missing words.
//
// Turns line up with audio in one of two ways:
// - `presses` (push-to-talk, the default): each stretch of audio between `finalize()` calls is the
//   next script turn, and its word times count from where that stretch starts in the stream.
// - `absolute` (hands-free): script times are session audio times.
//
// Faults: drop the socket at given audio times, hold finals back, refuse connects, raise errors,
// and refuse keyterm updates.
//
// Deterministic: the same audio and calls give the same events, byte for byte, given a fixed
// `clock` (socket times in usage read it) and `createId` (utterance ids).
//
// This module must never reach a production bundle. FAKE_STT_MARKER is a string that survives
// minification, for the web app's bundle check to look for.
import { type UtteranceFinalV2, uuidv7 } from "@earshot/core";
import { TARGET_SAMPLE_RATE } from "../capture/dsp";
import { VoiceError } from "../errors";
import {
  type SttAdapter,
  SttConnectError,
  type SttConnection,
  type SttConnectOptions,
  type SttErrorCode,
  type SttEvent,
  type SttLimits,
  type SttUsage,
  type TempCredential,
  type TempCredentialProvider,
} from "../stt/adapter";
import { normalizeKeyterm } from "../stt/keyterms";
import { toUtterances } from "../stt/normalize";
import { type Clock, systemClock } from "../stt/socket";

export const FAKE_STT_MARKER = "earshot.fake-stt";

const SAMPLES_PER_MS = TARGET_SAMPLE_RATE / 1000;

export interface FakeSttWord {
  readonly w: string;
  /** Script time, in ms. */
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence?: number;
}

export interface FakeSttTurn {
  readonly text: string;
  /** Where the turn's speech starts and ends, in script time (a fixture's own clock). */
  readonly startMs: number;
  readonly endMs: number;
  /** Word timings in script time. Without them, the turn's time is spread over its words. */
  readonly words?: readonly FakeSttWord[];
}

export interface FakeSttScript {
  readonly turns: readonly FakeSttTurn[];
}

export interface FakeSttFaults {
  /** Drop the socket (close 1006) when the session audio clock reaches each time, once each. */
  readonly dropAtMs?: readonly number[];
  /** Hold every final, and the end of turn after it, this long. */
  readonly finalDelayMs?: number;
  /** Refuse the first `count` connects. */
  readonly refuseConnects?: {
    readonly count: number;
    readonly code: SttErrorCode;
    readonly retryable?: boolean;
  };
  /** Raise an error event when the audio clock reaches each time. */
  readonly errorsAtMs?: readonly {
    readonly atMs: number;
    readonly code: SttErrorCode;
    readonly fatal?: boolean;
  }[];
  /** Refuse every keyterm update, as Deepgram does over its limit. */
  readonly rejectKeyterms?: boolean;
}

export interface FakeSttOptions {
  readonly script: FakeSttScript;
  readonly timeline?: "presses" | "absolute";
  /** Silence after a turn's last word before the fake ends the turn itself, in ms. */
  readonly endpointingMs?: number;
  readonly clock?: Clock;
  /** Utterance ids. Pass a counter for byte-identical runs; the default is UUIDv7. */
  readonly createId?: () => string;
  readonly faults?: FakeSttFaults;
  readonly limits?: Partial<SttLimits>;
}

export interface FakeSttStats {
  readonly connects: number;
  readonly refusedConnects: number;
  readonly drops: number;
  readonly samplesReceived: number;
  readonly bytesReceived: number;
  readonly finalizes: number;
  readonly keepAlives: number;
  /** The keyterms each connect carried, and each update after. */
  readonly connectKeyterms: readonly (readonly string[])[];
  readonly keytermUpdates: readonly (readonly string[])[];
  /** The `baseOffsetMs` of each connect: where each socket's audio started. */
  readonly baseOffsetsMs: readonly number[];
  readonly turnsEmitted: number;
}

export interface FakeSttAdapter extends SttAdapter {
  readonly id: "fake";
  stats(): FakeSttStats;
}

/**
 * A stand-in for `POST /api/voice/token`'s answer, for wiring the fake adapter where there's no
 * key: the fake ignores credentials, but the engine still asks for one on every connect.
 */
export function fakeCredential(provider: TempCredentialProvider = "assemblyai"): TempCredential {
  return {
    provider,
    credential: `${FAKE_STT_MARKER}.credential`,
    expiresAt: "2099-01-01T00:00:00.000Z",
    url: "wss://fake-stt.invalid",
  };
}

/**
 * Word timings for a turn without them: the turn's span spread over its words by character
 * count, a word's share counting one character of gap after it.
 */
export function spreadWords(
  text: string,
  startMs: number,
  endMs: number,
  confidence = 0.95,
): FakeSttWord[] {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const weight = words.reduce((sum, word) => sum + word.length + 1, 0);
  const span = Math.max(0, endMs - startMs);
  const out: FakeSttWord[] = [];
  let at = 0;
  for (const word of words) {
    const share = ((word.length + 1) / weight) * span;
    const wordStart = startMs + at;
    out.push({
      w: word,
      startMs: Math.round(wordStart),
      endMs: Math.round(wordStart + share * (word.length / (word.length + 1))),
      confidence,
    });
    at += share;
  }
  return out;
}

interface Interval {
  from: number;
  to: number;
}

/** The adapter's state, shared by every connection it makes. */
class FakeStt {
  readonly options: FakeSttOptions;
  readonly clock: Clock;
  readonly createId: () => string;
  readonly turns: readonly { turn: FakeSttTurn; words: readonly FakeSttWord[] }[];
  readonly endpointingSamples: number;
  /** Stream sample ranges heard so far, merged and sorted. */
  heard: Interval[] = [];
  turnIndex = 0;
  /** Where the current turn's stretch starts, in stream samples (presses timeline). */
  segmentStart: number | undefined;
  /** The current stretch already had its turn ended by endpointing. */
  endedInSegment = false;
  /** Words of the current turn already sent as partials. */
  partialWords = 0;
  readonly droppedAt = new Set<number>();
  readonly erroredAt = new Set<number>();
  stats = {
    connects: 0,
    refusedConnects: 0,
    drops: 0,
    samplesReceived: 0,
    finalizes: 0,
    keepAlives: 0,
    connectKeyterms: [] as string[][],
    keytermUpdates: [] as string[][],
    baseOffsetsMs: [] as number[],
    turnsEmitted: 0,
  };

  constructor(options: FakeSttOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.createId = options.createId ?? uuidv7;
    this.endpointingSamples = (options.endpointingMs ?? 800) * SAMPLES_PER_MS;
    this.turns = options.script.turns.map((turn) => ({
      turn,
      words: turn.words ?? spreadWords(turn.text, turn.startMs, turn.endMs),
    }));
  }

  get current() {
    return this.turns[this.turnIndex];
  }

  /** A script time in the current turn, as a stream sample. */
  streamSample(scriptMs: number): number | undefined {
    const entry = this.current;
    if (!entry) return undefined;
    if (this.options.timeline === "absolute") return scriptMs * SAMPLES_PER_MS;
    if (this.segmentStart === undefined) return undefined;
    return this.segmentStart + (scriptMs - entry.turn.startMs) * SAMPLES_PER_MS;
  }

  covered(from: number, to: number): boolean {
    return this.heard.some((interval) => interval.from <= from && interval.to >= to);
  }

  hear(from: number, to: number): void {
    if (to <= from) return;
    const merged: Interval[] = [];
    let next = { from, to };
    for (const interval of this.heard) {
      if (interval.to < next.from || interval.from > next.to) merged.push(interval);
      else next = { from: Math.min(next.from, interval.from), to: Math.max(next.to, interval.to) };
    }
    merged.push(next);
    merged.sort((a, b) => a.from - b.from);
    this.heard = merged;
  }

  /** The current turn's words heard so far, with session times. */
  heardWords(): { w: string; startMs: number; endMs: number; confidence: number }[] {
    const entry = this.current;
    if (!entry) return [];
    const out: { w: string; startMs: number; endMs: number; confidence: number }[] = [];
    for (const word of entry.words) {
      const from = this.streamSample(word.startMs);
      const to = this.streamSample(word.endMs);
      if (from === undefined || to === undefined) break;
      if (!this.covered(Math.max(0, Math.floor(from)), Math.max(0, Math.ceil(to)))) continue;
      out.push({
        w: word.w,
        startMs: from / SAMPLES_PER_MS,
        endMs: to / SAMPLES_PER_MS,
        confidence: word.confidence ?? 0.95,
      });
    }
    return out;
  }

  /** The current turn's final, from the words heard, then moves to the next turn. */
  endTurn(): UtteranceFinalV2[] {
    const entry = this.current;
    const words = this.heardWords();
    let utterances: UtteranceFinalV2[] = [];
    if (entry && words.length > 0) {
      const whole = words.length === entry.words.length;
      utterances = toUtterances(
        words.map((word) => ({
          text: word.w,
          startMs: word.startMs,
          endMs: word.endMs,
          confidence: word.confidence,
        })),
        {
          toSessionMs: (ms) => ms,
          text: whole ? entry.turn.text : words.map((word) => word.w).join(" "),
          createId: this.createId,
        },
      );
      this.stats.turnsEmitted += 1;
    }
    this.turnIndex += 1;
    this.partialWords = 0;
    return utterances;
  }
}

export function createFakeSttAdapter(options: FakeSttOptions): FakeSttAdapter {
  const state = new FakeStt(options);
  const limits: SttLimits = {
    maxKeyterms: 100,
    maxKeytermChars: 50,
    chunkMs: 64,
    ...options.limits,
  };
  return {
    id: "fake",
    provider: "fake",
    model: "fake",
    limits,
    async connect(opts: SttConnectOptions): Promise<SttConnection> {
      if (opts.signal?.aborted) throw opts.signal.reason;
      const refuse = options.faults?.refuseConnects;
      if (refuse && state.stats.refusedConnects < refuse.count) {
        state.stats.refusedConnects += 1;
        throw new SttConnectError(refuse.code, `${FAKE_STT_MARKER}: connect refused`, {
          retryable: refuse.retryable ?? true,
        });
      }
      state.stats.connects += 1;
      state.stats.baseOffsetsMs.push(opts.baseOffsetMs);
      state.stats.connectKeyterms.push(keytermsFor(opts.keyterms, limits));
      await Promise.resolve();
      if (opts.signal?.aborted) throw opts.signal.reason;
      return new FakeSttConnection(state, opts, limits);
    },
    stats(): FakeSttStats {
      return {
        ...state.stats,
        bytesReceived: state.stats.samplesReceived * 2,
        connectKeyterms: state.stats.connectKeyterms.map((terms) => [...terms]),
        keytermUpdates: state.stats.keytermUpdates.map((terms) => [...terms]),
        baseOffsetsMs: [...state.stats.baseOffsetsMs],
      };
    },
  };
}

function keytermsFor(terms: readonly string[], limits: SttLimits): string[] {
  return terms
    .map(normalizeKeyterm)
    .filter((term) => term !== "")
    .slice(0, limits.maxKeyterms);
}

class FakeSttConnection implements SttConnection {
  readonly #state: FakeStt;
  readonly #limits: SttLimits;
  readonly #listeners = new Set<(event: SttEvent) => void>();
  readonly #baseSample: number;
  readonly #openedAt: number;
  #received = 0;
  #open = true;
  /** Events held back by `finalDelayMs`, in order. */
  #held: SttEvent[][] = [];

  constructor(state: FakeStt, opts: SttConnectOptions, limits: SttLimits) {
    this.#state = state;
    this.#limits = limits;
    this.#baseSample = Math.round(opts.baseOffsetMs * SAMPLES_PER_MS);
    this.#openedAt = state.clock.now();
  }

  on(listener: (event: SttEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  send(pcm16: Int16Array): void {
    if (!this.#open || pcm16.length === 0) return;
    const state = this.#state;
    const from = this.#baseSample + this.#received;
    let to = from + pcm16.length;
    const drop = (state.options.faults?.dropAtMs ?? []).find(
      (ms) => !state.droppedAt.has(ms) && ms * SAMPLES_PER_MS < to && ms * SAMPLES_PER_MS >= from,
    );
    if (drop !== undefined) to = drop * SAMPLES_PER_MS; // the provider never got the rest
    state.stats.samplesReceived += to - from;
    this.#received += to - from;
    if (state.options.timeline !== "absolute" && state.segmentStart === undefined) {
      state.segmentStart = from;
    }
    state.hear(from, to);
    this.#raiseErrors(from, to);
    this.#advance(to);
    if (drop !== undefined) {
      state.droppedAt.add(drop);
      state.stats.drops += 1;
      this.#drop();
    }
  }

  finalize(): void {
    if (!this.#open) return;
    const state = this.#state;
    state.stats.finalizes += 1;
    const events: SttEvent[] = [];
    if (state.options.timeline === "absolute") {
      if (state.heardWords().length > 0) events.push(...finals(state.endTurn()));
    } else if (!state.endedInSegment) {
      events.push(...finals(state.endTurn()));
    }
    events.push({ type: "end_of_turn" });
    if (state.options.timeline !== "absolute") {
      state.segmentStart = this.#baseSample + this.#received;
      state.endedInSegment = false;
    }
    this.#emitTurn(events);
  }

  async updateKeyterms(terms: readonly string[]): Promise<void> {
    const state = this.#state;
    const kept = keytermsFor(terms, this.#limits);
    state.stats.keytermUpdates.push(kept);
    if (state.options.faults?.rejectKeyterms) {
      this.#emit({
        type: "error",
        code: "keyterms_rejected",
        message: `${FAKE_STT_MARKER}: keyterms refused`,
        fatal: false,
      });
      throw new VoiceError("keyterms_rejected", "the fake refused the keyterms");
    }
  }

  keepAlive(): void {
    if (this.#open) this.#state.stats.keepAlives += 1;
  }

  async close(): Promise<SttUsage> {
    const usage = this.#usage();
    if (this.#open) {
      this.#open = false;
      this.#flushHeld();
      this.#emit({ type: "closed", code: 1000, expected: true, usage });
    }
    return usage;
  }

  /** Emits partials for newly heard words, and ends a turn whose endpointing silence has passed. */
  #advance(clock: number): void {
    const state = this.#state;
    for (;;) {
      const entry = state.current;
      if (!entry) return;
      if (state.options.timeline !== "absolute" && state.endedInSegment) return;
      const words = state.heardWords();
      if (words.length > state.partialWords) {
        state.partialWords = words.length;
        this.#emit({
          type: "partial",
          text: words.map((word) => word.w).join(" "),
          startMs: Math.round(words[0]?.startMs ?? 0),
          endMs: Math.round(words.at(-1)?.endMs ?? 0),
        });
      }
      const end = state.streamSample(entry.turn.endMs);
      if (end === undefined || clock < end + state.endpointingSamples) return;
      if (words.length === 0) {
        if (state.options.timeline !== "absolute") return; // a press with no words: finalize ends it
        state.turnIndex += 1; // hands-free: the stream never held this turn, so skip it
        state.partialWords = 0;
        continue;
      }
      this.#emitTurn([...finals(state.endTurn()), { type: "end_of_turn" }]);
      if (state.options.timeline !== "absolute") {
        state.endedInSegment = true;
        return;
      }
    }
  }

  #raiseErrors(from: number, to: number): void {
    const state = this.#state;
    for (const fault of state.options.faults?.errorsAtMs ?? []) {
      const at = fault.atMs * SAMPLES_PER_MS;
      if (state.erroredAt.has(fault.atMs) || at < from || at >= to) continue;
      state.erroredAt.add(fault.atMs);
      this.#emit({
        type: "error",
        code: fault.code,
        message: `${FAKE_STT_MARKER}: scripted error`,
        fatal: fault.fatal ?? false,
      });
      if (fault.fatal) this.#drop();
    }
  }

  /** A turn's finals and end of turn, held back by `finalDelayMs` when set. */
  #emitTurn(events: SttEvent[]): void {
    const delay = this.#state.options.faults?.finalDelayMs ?? 0;
    if (delay <= 0) {
      for (const event of events) this.#emit(event);
      return;
    }
    this.#held.push(events);
    this.#state.clock.setTimeout(() => {
      const next = this.#held.shift();
      if (next && this.#open) for (const event of next) this.#emit(event);
    }, delay);
  }

  #flushHeld(): void {
    for (const events of this.#held.splice(0)) for (const event of events) this.#emit(event);
  }

  #drop(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#held = []; // a dropped socket's late finals are lost, as they would be
    this.#emit({
      type: "error",
      code: "connection_lost",
      message: `${FAKE_STT_MARKER}: socket dropped`,
      fatal: true,
    });
    this.#emit({ type: "closed", code: 1006, expected: false, usage: this.#usage() });
  }

  #usage(): SttUsage {
    return {
      provider: "fake",
      model: "fake",
      audioMs: Math.round(this.#received / SAMPLES_PER_MS),
      socketMs: Math.max(0, Math.round(this.#state.clock.now() - this.#openedAt)),
      source: "client",
    };
  }

  #emit(event: SttEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function finals(utterances: readonly UtteranceFinalV2[]): SttEvent[] {
  return utterances.map((utterance) => ({ type: "final", utterance }));
}
