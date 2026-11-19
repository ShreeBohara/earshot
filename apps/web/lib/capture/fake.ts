// Types for the capture screen's development-only fake mode: the fake speech-to-text adapter and
// the edge Worker's `dev:e2e` entry, whose cassettes answer every turn, so a whole debrief runs
// with no keys and no provider calls. The fake code itself lives in ./dev/ and is imported only
// behind `process.env.NODE_ENV === "development"`, which production builds replace with false;
// the Worker bundle check fails if it ever reaches a bundle (scripts/check-worker-bundle.mjs).
import type { EntityRef, LlmProvider, SessionProviders } from "@earshot/core";
import type { SttAdapter, TempCredential } from "@earshot/voice";

/**
 * The e2e scenario that `wrangler dev src/e2e.ts` serves (apps/edge/src/e2e.ts): a scripted
 * session the Worker's cassettes answer. Each cassette is keyed by the whole LLM request, so the session's
 * entities, call time, and time zone come from here too, not from the CRM.
 */
export interface FakeScenario {
  readonly version: 1;
  readonly name: string;
  readonly startedAt: string;
  readonly timeZone: string;
  readonly entities: readonly EntityRef[];
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
