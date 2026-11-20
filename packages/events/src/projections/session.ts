import type { SessionMode, SessionProviders, VoiceEngine } from "@earshot/core";
import { ProjectionError } from "../errors";
import type { Projection } from "./projection";

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
  costUsd: number | null;
  /** The seq and timestamp of the latest event, reviews after the end included. */
  lastSeq: number;
  lastEventAt: string;
}

/**
 * Folds `session.started`, `session.ended`, and `session.sealed` into a `SessionView`; `null`
 * until the session starts. A session log must open with `session.started`. Events may follow
 * `session.ended`, because reviews and late transcripts often land after capture stops;
 * `usage.recorded` after the end adds to the session's cost. A session is sealed once, after it
 * ends, and events may follow the seal too: the web Worker's reviews.
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
