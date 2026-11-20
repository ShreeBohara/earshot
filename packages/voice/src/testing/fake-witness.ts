// A scripted second witness (Phase 4 spec WP9 step 6), for the e2e and capture tests: it never
// looks at the audio. Each `transcribe` call is the next turn of its script, in the order the
// session's turns reach it, and says that turn's lines as an unbiased transcript on the session's
// clock: the turn's start plus each word's time. A script turn can mishear a name (the e2e's
// "Atmo Systems" for "Atmos Industrial"), fail as the provider would, or take its time.
//
// Never in production: the web app's bundle check looks for FAKE_STT_MARKER, which fake mode's
// placeholder key carries.
import { uuidv7 } from "@earshot/core";
import {
  type TranscribeOptions,
  type UnbiasedUtterance,
  WITNESS_MODEL,
  WITNESS_PROVIDER,
  type WitnessFailure,
  type WitnessResult,
  type WitnessRunner,
} from "../witness/runner";
import { audioMsOf } from "../witness/wav";
import { type FakeSttWord, spreadWords } from "./fake-stt";

/** What the witness hears in one turn, in the turn's own time (ms from its start). */
export interface FakeWitnessTurn {
  /** Its transcript. Without `words`, the words are spread over `[startMs, endMs]`. */
  readonly text?: string;
  readonly words?: readonly FakeSttWord[];
  readonly startMs?: number;
  readonly endMs?: number;
  /** Or a failure, as the provider would give it. */
  readonly failure?: WitnessFailure;
  /** The latency it reports (default 0). */
  readonly latencyMs?: number;
}

export interface FakeWitnessOptions {
  readonly script: { readonly turns: readonly FakeWitnessTurn[] };
  readonly provider?: string;
  readonly model?: string;
  /** Utterance ids. Defaults to UUIDv7. */
  readonly createId?: () => string;
  /** Awaited before a call's answer: hold turn `index` back to test ordering. */
  readonly gate?: (index: number) => Promise<void>;
  /** The span a turn's words are spread over without timings (default 1.2 s, as fake mode). */
  readonly lineMs?: number;
}

export interface FakeWitness extends WitnessRunner {
  /** Every call: the audio it got and where its turn starts. */
  readonly calls: readonly { readonly samples: number; readonly turnStartMs: number }[];
}

export function createFakeWitness(options: FakeWitnessOptions): FakeWitness {
  const calls: { samples: number; turnStartMs: number }[] = [];
  const createId = options.createId ?? uuidv7;
  const lineMs = options.lineMs ?? 1_200;
  return {
    provider: options.provider ?? WITNESS_PROVIDER,
    model: options.model ?? WITNESS_MODEL,
    calls,
    async transcribe(pcm16: Int16Array, transcribe: TranscribeOptions): Promise<WitnessResult> {
      const index = calls.length;
      calls.push({ samples: pcm16.length, turnStartMs: transcribe.turnStartMs });
      await options.gate?.(index);
      const turn = options.script.turns[index];
      const latencyMs = turn?.latencyMs ?? 0;
      if (!turn || turn.failure || !turn.text?.trim()) {
        return { failure: turn?.failure ?? "provider_error", latencyMs };
      }
      const base = Math.max(0, Math.round(transcribe.turnStartMs));
      const words = (turn.words ?? spreadWords(turn.text, turn.startMs ?? 0, turn.endMs ?? lineMs))
        .filter((word) => word.w.trim() !== "")
        .map((word) => ({
          w: word.w,
          startMs: base + Math.round(word.startMs),
          endMs: base + Math.round(Math.max(word.startMs, word.endMs)),
          confidence: word.confidence ?? 0.9,
        }));
      const utterance: UnbiasedUtterance = {
        utteranceId: createId(),
        text: turn.text.trim(),
        confidence: 0.9,
        ...(words.length > 0 ? { words } : {}),
        startMs: words[0]?.startMs ?? base,
        endMs: words.at(-1)?.endMs ?? base,
        witness: "unbiased",
      };
      return { utterance, audioMs: audioMsOf(pcm16.length), latencyMs };
    },
  };
}
