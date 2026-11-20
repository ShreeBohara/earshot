// The repair path (Phase 5 spec §4.3, WP3): seals sessions whose seal never came, so the inbox can
// review them. The inbox loader (WP5) calls `repairUnsealedSessions` on each load.
//
// - It picks at most 20 of the viewer's sessions with events and no seal in Postgres: ended more
//   than 10 minutes ago, or never ended and started more than 2 hours ago (targets).
// - It asks their Durable Objects to seal now (`env.EDGE.sealSessions`). `live` is left alone;
//   `sealing` seals itself and its flush brings the seal to Postgres; `sealed` is on its way.
// - For `gone` (the object holds no log, so it can never write again), it seals Postgres's copy
//   under the session's lock (`sealSessionLog`), with `session.ended` first if the log never ended.
//
// Nothing here throws: a failure is logged and the inbox loads with what Postgres has.
import { uuidv7 } from "@earshot/core";
import { sealSessionLog, unsealedSessions } from "@earshot/db";
import type { withViewerTenant } from "../auth/viewer";
import type { Viewer } from "../auth/viewer-core";
import type { Logger } from "../log";

/** The repair path's targets. */
export const SEAL_REPAIR = {
  /** Ask about a session this long after it ended without a seal. */
  endedMs: 10 * 60_000,
  /** Ask about a session that never ended this long after it started. */
  neverEndedMs: 2 * 60 * 60_000,
  /** The most sessions one inbox load asks about. */
  perLoad: 20,
} as const;

export type SealAnswer = "live" | "sealing" | "sealed" | "gone";

/** The edge Worker's `sealSessions` RPC (apps/edge/src/index.ts). */
export type SealSessions = (
  sessionIds: string[],
) => Promise<
  | { ok: true; sessions: Record<string, SealAnswer> }
  | { ok: false; reason: "too_many" | "invalid_session_id" }
>;

export type SealRepairDeps = {
  withViewerTenant: typeof withViewerTenant;
  sealSessions: SealSessions;
  now: () => Date;
  log: Logger;
};

export type SealRepairReport = {
  /** Sessions asked about. */
  asked: number;
  /** What their objects answered. */
  answers: Record<SealAnswer, number>;
  /** `gone` sessions sealed here. */
  repaired: number;
  /** The edge Worker couldn't be asked; nothing was repaired. */
  unreachable: boolean;
};

/** Seals what it can of the viewer's unsealed sessions (see the top of the file). */
export async function repairUnsealedSessions(
  viewer: Viewer,
  deps: SealRepairDeps,
): Promise<SealRepairReport> {
  const now = deps.now();
  const report: SealRepairReport = {
    asked: 0,
    answers: { live: 0, sealing: 0, sealed: 0, gone: 0 },
    repaired: 0,
    unreachable: false,
  };
  try {
    const ids = await deps.withViewerTenant(
      (tx) =>
        unsealedSessions(tx, {
          endedBefore: new Date(now.getTime() - SEAL_REPAIR.endedMs),
          startedBefore: new Date(now.getTime() - SEAL_REPAIR.neverEndedMs),
          limit: SEAL_REPAIR.perLoad,
        }),
      viewer,
    );
    if (ids.length === 0) return report;
    report.asked = ids.length;

    let answers: Record<string, SealAnswer>;
    try {
      const result = await deps.sealSessions(ids);
      if (!result.ok) throw new Error(`the edge Worker refused: ${result.reason}`);
      answers = result.sessions;
    } catch (error) {
      deps.log.warn("seal repair skipped: the edge Worker didn't answer", { error });
      return { ...report, unreachable: true };
    }

    for (const id of ids) {
      const answer = answers[id];
      if (!answer) continue;
      report.answers[answer] += 1;
      if (answer !== "gone") continue;
      try {
        const outcome = await deps.withViewerTenant(
          (tx) => sealSessionLog(tx, id, { now, newId: uuidv7 }),
          viewer,
        );
        if (outcome === "sealed") report.repaired += 1;
      } catch (error) {
        deps.log.error("seal repair failed for a session", { error });
      }
    }
    deps.log.info("seal repair", {
      asked: report.asked,
      ...report.answers,
      repaired: report.repaired,
    });
    return report;
  } catch (error) {
    deps.log.error("seal repair failed", { error });
    return report;
  }
}
