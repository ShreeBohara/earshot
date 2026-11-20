// Types for the capture screen's development-only fake mode: the fake speech-to-text adapter and
// the edge Worker's `dev:e2e` entry, whose cassettes answer every turn, so a whole debrief runs
// with no keys and no provider calls. The fake code itself lives in ./dev/ and is imported only
// behind `process.env.NODE_ENV === "development"`, which production builds replace with false;
// the Worker bundle check fails if it ever reaches a bundle (scripts/check-worker-bundle.mjs).
import type { EntityRef, LlmProvider, SessionProviders } from "@earshot/core";
import type { SttAdapter, TempCredential } from "@earshot/voice";

/**
 * The e2e scenario that `wrangler dev src/e2e.ts` serves (apps/edge/src/e2e.ts): a scripted
 * session the Worker's cassettes answer. Each cassette is keyed by the whole LLM request, so the
 * session's open account, call time, and time zone come from here too, not from the CRM, and so
 * do the entities the linker reads.
 */
export interface FakeScenario {
  readonly version: 1;
  readonly name: string;
  readonly startedAt: string;
  readonly timeZone: string;
  readonly entities: readonly EntityRef[];
  /**
   * The account open in Earshot, one of `entities`: prompt v2 names it, so the cassettes were
   * recorded with it (Phase 4 WP8). Null or absent for none.
   */
  readonly focusEntityId?: string | null;
  readonly llm: { readonly provider: LlmProvider; readonly model: string };
  readonly turns: readonly { readonly text: string }[];
}

/** What the /capture page found when fake mode was asked for. */
export type FakeVoiceSetup =
  | { readonly status: "ready"; readonly scenario: FakeScenario }
  | { readonly status: "unavailable"; readonly scenarioUrl: string };

/** The pieces a fake session runs on, built in the browser by ./dev/fake-voice.ts. */
export interface FakeVoice {
  readonly scenario: FakeScenario;
  readonly providers: SessionProviders;
  /** Not a key: a well-formed placeholder for `turn_end`, which the cassettes never read. */
  readonly turnKey: string;
  /** A fake adapter that says the scenario's lines from `fromTurn` on, one per press. */
  createAdapter(fromTurn: number): SttAdapter;
  credential(): TempCredential;
  /** How long to hold push-to-talk for a whole line to be heard. */
  readonly holdMs: number;
}

/** The query flag that asks for fake mode under `next dev`: `/capture?voice=fake`. */
export const FAKE_VOICE_PARAM = { name: "voice", value: "fake" } as const;

/**
 * Fake mode's other query flags: `script=d001` plays an eval debrief instead of the demo session
 * (the e2e Worker serves its scenario), and `llm=groq` names Groq's cassettes instead of
 * Anthropic's.
 */
export const FAKE_SCRIPT_PARAM = "script";
export const FAKE_LLM_PARAM = "llm";

/**
 * Where each scripted line is spoken in the WAV Chrome's fake microphone plays: the renderer's
 * timing.json (`DebriefTiming` in @earshot/evals), as the fake-microphone eval (e2e/eval) puts it
 * on the page before the page loads, in `globalThis[FAKE_TIMING_GLOBAL]`. With it, the fake
 * adapter hears each press's line on the WAV's own timings; without it, each line is spread over
 * a fixed span from the start of its press.
 */
export interface FakeTiming {
  readonly turns: readonly {
    readonly text: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly words: readonly {
      readonly w: string;
      readonly startMs: number;
      readonly endMs: number;
    }[];
  }[];
}

export const FAKE_TIMING_GLOBAL = "__earshotFakeTiming";

/**
 * What the page's fake adapters have received, for the fake-microphone smoke test to read:
 * `globalThis[FAKE_STATS_GLOBAL]()`. `timing` says whether the lines follow a WAV's timing.json.
 */
export interface FakeVoiceStats {
  readonly timing: "wav" | "fixed";
  readonly adapters: readonly {
    readonly samplesReceived: number;
    readonly bytesReceived: number;
    readonly finalizes: number;
    readonly turnsEmitted: number;
  }[];
}

export const FAKE_STATS_GLOBAL = "__earshotFakeVoiceStats";
