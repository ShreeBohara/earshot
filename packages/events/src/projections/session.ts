import type { RecapCreatedV1, SessionMode, SessionProviders, VoiceEngine } from "@earshot/core";
import { ProjectionError } from "../errors";
import type { Projection } from "./projection";

/**
 * The session's recap (Phase 5 WP10, spec §4.9): `recap.created` as written, with the seq and
 * time of its event. One per session, written after `session.ended` and before the seal.
 */
export type SessionRecap = RecapCreatedV1 & { readonly seq: number; readonly ts: string };

/** One session's status, setup, timings, and cost: the `sessions` row. */
export interface SessionView {
  sessionId: string;
  status: "active" | "ended";
  mode: SessionMode;
  engine: VoiceEngine;
  providers: SessionProviders;
  startedAt: string;
  endedAt: string | null;
  /**
   * When `session.sealed` says the session was sealed: its live writer is done, and the web
   * Worker writes its reviews from then on. Null until then.
   */
  sealedAt: string | null;
  /** `endedAt - startedAt` in ms, once the session has ended. */
  durationMs: number | null;
  /**
   * The debrief's recap, or why there's none (`recap.created`, Phase 5 WP10): written by
   * `SessionDO` after the end and before the seal. Null until then, and for sessions from before.
   */
  recap: SessionRecap | null;
  costUsd: number | null;
  /** The seq and timestamp of the latest event, reviews after the end included. */
  lastSeq: number;
  lastEventAt: string;
}

/**
 * Why a recap breaks the rules its writer keeps, which its schema can't say (Phase 5 spec §4.9),
 * or null: a created recap has no reason, and a failed or skipped one has a reason and nothing
 * else (no sentences, drops, or lens); at most one headline, and it comes first; a lens field has
 * a quote and its evidence, or neither ("not mentioned"), each field once. A fixed phrase, never
 * the recap's words.
 */
export function recapProblem(recap: RecapCreatedV1): string | null {
  if (recap.outcome === "created") {
    if (recap.reason !== null) return "a created recap has no reason";
  } else {
    if (recap.reason === null) return `a ${recap.outcome} recap says why`;
    if (recap.sentences.length > 0 || recap.dropped > 0 || recap.lens !== null) {
      return `a ${recap.outcome} recap holds no sentences, drops, or lens`;
    }
  }
  // Skipped means never attempted: no key, or nothing said. Every other reason is a failure.
  const neverAttempted = recap.reason === "no_key" || recap.reason === "no_speech";
  if (recap.outcome === "skipped" && !neverAttempted) return "a skipped recap had no key or speech";
  if (recap.outcome === "failed" && neverAttempted)
    return "a recap with no key or speech is skipped";
  const headlines = recap.sentences.filter((sentence) => sentence.kind === "headline").length;
  if (headlines > 1) return "a recap keeps one headline";
  if (headlines === 1 && recap.sentences[0]?.kind !== "headline") {
    return "the headline comes first";
  }
  if (recap.lens) {
    const seen = new Set<string>();
    for (const field of recap.lens.fields) {
      if ((field.quote === null) !== (field.evidence === null)) {
        return "a lens field has a quote and its evidence, or neither";
      }
      if (seen.has(field.field)) return "a lens names each field once";
      seen.add(field.field);
    }
  }
  return null;
}

/**
 * Folds `session.started`, `session.ended`, `session.sealed`, and `recap.created` into a
 * `SessionView`; `null` until the session starts. A session log must open with `session.started`.
 * Events may follow `session.ended`, because reviews and late transcripts often land after capture
 * stops; `usage.recorded` after the end adds to the session's cost. A session is sealed once,
 * after it ends, and events may follow the seal too: the web Worker's reviews. Its recap comes
 * once, between the end and the seal; a recap anywhere else, or one that breaks its writer's
 * rules (`recapProblem`), is a writer's bug, and fails the fold.
 */
export const sessionProjection: Projection<SessionView | null> = {
  initial: null,
  apply(state, event) {
    if (event.type === "session.started") {
      if (state) throw new ProjectionError("session", event, "the session has already started");
      return {
        sessionId: event.sessionId,
        status: "active",
        mode: event.payload.mode,
        engine: event.payload.engine,
        providers: event.payload.providers,
        startedAt: event.payload.startedAt,
        endedAt: null,
        sealedAt: null,
        durationMs: null,
        recap: null,
        costUsd: null,
        lastSeq: event.seq,
        lastEventAt: event.ts,
      };
    }
    if (!state) {
      throw new ProjectionError("session", event, "the log must open with session.started");
    }
    if (event.type === "session.ended") {
      if (state.status === "ended") {
        throw new ProjectionError("session", event, "the session has already ended");
      }
      return {
        ...state,
        status: "ended",
        endedAt: event.payload.endedAt,
        durationMs: Date.parse(event.payload.endedAt) - Date.parse(state.startedAt),
        costUsd: event.payload.costUsd ?? null,
        lastSeq: event.seq,
        lastEventAt: event.ts,
      };
    }
    if (event.type === "session.sealed") {
      if (state.status !== "ended") {
        throw new ProjectionError("session", event, "the session can't be sealed before it ends");
      }
      if (state.sealedAt !== null) {
        throw new ProjectionError("session", event, "the session has already been sealed");
      }
      return {
        ...state,
        sealedAt: event.payload.sealedAt,
        lastSeq: event.seq,
        lastEventAt: event.ts,
      };
    }
    if (event.type === "recap.created") {
      if (state.status !== "ended") {
        throw new ProjectionError("session", event, "the recap comes after the session ends");
      }
      if (state.sealedAt !== null) {
        throw new ProjectionError("session", event, "the recap comes before the seal");
      }
      if (state.recap !== null) {
        throw new ProjectionError("session", event, "the session already has its recap");
      }
      const problem = recapProblem(event.payload);
      if (problem) throw new ProjectionError("session", event, problem);
      return {
        ...state,
        recap: { ...event.payload, seq: event.seq, ts: event.ts },
        lastSeq: event.seq,
        lastEventAt: event.ts,
      };
    }
    if (event.type === "usage.recorded" && state.status === "ended") {
      // Usage reported after the end (a speech-to-text socket that closed late) adds to the
      // total session.ended recorded; before the end, session.ended's total already includes it.
      return {
        ...state,
        costUsd: roundUsd((state.costUsd ?? 0) + event.payload.costUsd),
        lastSeq: event.seq,
        lastEventAt: event.ts,
      };
    }
    return { ...state, lastSeq: event.seq, lastEventAt: event.ts };
  },
};

/** Rounds to a billionth of a dollar, as SessionDO's meter does, so sums stay exact enough. */
function roundUsd(usd: number): number {
  return Math.round(usd * 1e9) / 1e9;
}
