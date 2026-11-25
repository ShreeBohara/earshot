// The pilot page's own record of what the participant did (Phase 5 spec WP7 step 2; ADR-0039):
// the reviews and snoozes its local sink writes, folded into the sessions in the page with the
// projection production uses, after the writers' own rules (`checkReviews`, `checkSnooze`). Kept in
// `sessionStorage` under the participant's label, only once they've agreed, so a reload keeps
// their place and closing the tab keeps nothing. Nothing leaves the page but the results file.
import {
  ProposalReviewedV2,
  type ProposalSnoozedV1,
  type Reviewer,
  type ReviewInput,
  type SnoozeInput,
  UNDO_WINDOW_MS,
} from "@earshot/core";
import {
  checkReviews,
  checkSnooze,
  type ProposalView,
  proposalsProjection,
  type ReviewRefusal,
} from "@earshot/events";
import { tierOf } from "@earshot/understanding/tiers";
import type { ReviewSink, SinkRefusal, SinkResult } from "@/lib/inbox/sinks";
import type { InboxSession } from "@/lib/inbox/types";
import { inboxProposal } from "./data";

/** One write of the local sink, in the order the page made it. */
export type PilotEvent =
  | {
      readonly sessionId: string;
      readonly type: "proposal.reviewed";
      readonly ts: string;
      readonly payload: ProposalReviewedV2;
    }
  | {
      readonly sessionId: string;
      readonly type: "proposal.snoozed";
      readonly ts: string;
      readonly payload: ProposalSnoozedV1;
    };

/** The page's place in the pilot, after "I agree". */
export type PilotPhase = "practice" | "review";

/** What `sessionStorage` keeps for one participant: their place, and every write so far. */
export interface PilotProgress {
  readonly v: 1;
  readonly setSha256: string;
  readonly participant: string;
  /** When they agreed: the results file's `startedAt`. */
  readonly startedAt: string;
  readonly phase: PilotPhase;
  readonly practice: readonly PilotEvent[];
  readonly events: readonly PilotEvent[];
}

/** The `sessionStorage` key for a participant's progress. */
export function progressKey(participant: string): string {
  return `earshot.pilot.${participant}`;
}

function isEvent(value: unknown): value is PilotEvent {
  if (value === null || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.sessionId === "string" &&
    typeof event.ts === "string" &&
    (event.type === "proposal.reviewed" || event.type === "proposal.snoozed") &&
    event.payload !== null &&
    typeof event.payload === "object"
  );
}

/**
 * A participant's stored progress for this set, or null: none yet, unreadable, or from another
 * build of the set (its writes would name proposals this one may not have).
 */
export function readProgress(
  storage: Pick<Storage, "getItem">,
  participant: string,
  setSha256: string,
): PilotProgress | null {
  let raw: string | null;
  try {
    raw = storage.getItem(progressKey(participant));
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<PilotProgress>;
    if (
      value.v !== 1 ||
      value.setSha256 !== setSha256 ||
      value.participant !== participant ||
      typeof value.startedAt !== "string" ||
      (value.phase !== "practice" && value.phase !== "review") ||
      !Array.isArray(value.practice) ||
      !Array.isArray(value.events) ||
      !value.practice.every(isEvent) ||
      !value.events.every(isEvent)
    ) {
      return null;
    }
    return value as PilotProgress;
  } catch {
    return null;
  }
}

/** Keeps the participant's progress; a full or refused storage loses only the reload's help. */
export function writeProgress(storage: Pick<Storage, "setItem">, progress: PilotProgress): void {
  try {
    storage.setItem(progressKey(progress.participant), JSON.stringify(progress));
  } catch {
    // Nothing to do: the page still holds everything, and the download still works.
  }
}

/** Why a local write was refused, as the review list's refusals. */
function refusal(reason: ReviewRefusal): SinkRefusal {
  switch (reason) {
    case "not_proposed":
    case "not_latest":
    case "nothing_to_reopen":
    case "superseded":
    case "syncing":
    case "synced":
      return "stale";
    case "unknown_proposal":
      return "gone";
    default:
      return "invalid";
  }
}

/** The proposals of a session as the projection holds them: the loaded ones carry no review. */
function viewsOf(session: InboxSession): ProposalView[] {
  return session.proposals.map((proposal) => ({ ...proposal, review: null }) as ProposalView);
}

/**
 * Folds one write into a session's proposals with `proposalsProjection`, as a replay would: the
 * envelope's seq follows the session's own events. A review folds as `proposal.reviewed` v3, the
 * version every writer writes (Phase 6 WP1); its payload is v2's shape, which every v3 review a
 * person makes has, and the results file keeps it as pre-registered (ADR-0039).
 */
function fold(views: ProposalView[], event: PilotEvent, seq: number): ProposalView[] {
  const common = { id: `00000000-0000-7000-8000-${seq.toString(16).padStart(12, "0")}`, seq };
  const next =
    event.type === "proposal.reviewed"
      ? proposalsProjection.apply(views, {
          ...common,
          sessionId: event.sessionId,
          type: "proposal.reviewed",
          schemaVersion: 3,
          ts: event.ts,
          payload: event.payload,
        })
      : proposalsProjection.apply(views, {
          ...common,
          sessionId: event.sessionId,
          type: "proposal.snoozed",
          schemaVersion: 1,
          ts: event.ts,
          payload: event.payload,
        });
  return [...next];
}

/**
 * The page's local log over some of the set's sessions: the writes so far folded in, and a
 * `ReviewSink` that checks each new one against the writers' rules, folds it, and hands the whole
 * list to `onChange` to keep. `by` is the participant's label with no sign-in: nobody signs in.
 */
export class LocalReviewLog {
  readonly #base: ReadonlyMap<string, InboxSession>;
  readonly #views = new Map<string, ProposalView[]>();
  readonly #seqs = new Map<string, number>();
  readonly #by: Reviewer;
  readonly #now: () => Date;
  readonly #onChange: (events: readonly PilotEvent[]) => void;
  #events: PilotEvent[] = [];

  constructor(
    sessions: readonly InboxSession[],
    events: readonly PilotEvent[],
    options: {
      readonly participant: string;
      readonly onChange?: (events: readonly PilotEvent[]) => void;
      readonly now?: () => Date;
    },
  ) {
    this.#base = new Map(sessions.map((session) => [session.sessionId, session]));
    for (const session of sessions) {
      this.#views.set(session.sessionId, viewsOf(session));
      this.#seqs.set(session.sessionId, Math.max(0, ...session.proposals.map((p) => p.seq)) + 1);
    }
    this.#by = { userId: options.participant, auth: null };
    this.#now = options.now ?? (() => new Date());
    this.#onChange = options.onChange ?? (() => {});
    // Only the page writes these, so they fold; if a stored write doesn't, keep what did.
    for (const event of events) {
      if (!this.#views.has(event.sessionId)) continue;
      try {
        this.#apply(event);
      } catch {
        break;
      }
    }
  }

  #apply(event: PilotEvent): void {
    const views = this.#views.get(event.sessionId) ?? [];
    const seq = (this.#seqs.get(event.sessionId) ?? 0) + 1;
    this.#views.set(event.sessionId, fold(views, event, seq));
    this.#seqs.set(event.sessionId, seq);
    this.#events.push(event);
  }

  /** Every write so far, in order. */
  events(): readonly PilotEvent[] {
    return this.#events;
  }

  /** The sessions with every write folded in, as the review list takes them. */
  sessions(): InboxSession[] {
    return [...this.#base.values()].map((session) => ({
      ...session,
      proposals: (this.#views.get(session.sessionId) ?? []).map(inboxProposal),
    }));
  }

  /** The reviews written so far, in order: the results file's `reviews` (or `practice`). */
  reviews(): ProposalReviewedV2[] {
    return this.#events.flatMap((event) =>
      event.type === "proposal.reviewed" ? [event.payload] : [],
    );
  }

  /** Writes one request locally, all or nothing, as the web route would. */
  write(
    sessionId: string,
    request: { readonly reviews: readonly ReviewInput[]; readonly snoozes: readonly SnoozeInput[] },
  ): SinkResult {
    const views = this.#views.get(sessionId);
    if (!views) return { ok: false, reason: "gone" };
    const now = this.#now();
    const ts = now.toISOString();
    const reviews: ProposalReviewedV2[] = [];
    for (const input of request.reviews) {
      const decides = input.decision === "approved" || input.decision === "edited";
      const parsed = ProposalReviewedV2.safeParse({
        ...input,
        syncEligibleAt: decides ? new Date(now.getTime() + UNDO_WINDOW_MS).toISOString() : null,
        by: this.#by,
      });
      if (!parsed.success) return { ok: false, reason: "invalid" };
      reviews.push(parsed.data);
    }
    const check = checkReviews(views, reviews, { tierOf, from: "client" });
    if (!check.ok) return { ok: false, reason: refusal(check.reason) };
    const snoozes: ProposalSnoozedV1[] = request.snoozes.map((input) => ({
      ...input,
      by: this.#by,
    }));
    for (const snooze of snoozes) {
      const snoozeCheck = checkSnooze(views, snooze);
      if (!snoozeCheck.ok) return { ok: false, reason: refusal(snoozeCheck.reason) };
    }
    for (const payload of reviews) {
      this.#apply({ sessionId, type: "proposal.reviewed", ts, payload });
    }
    for (const payload of snoozes) {
      this.#apply({ sessionId, type: "proposal.snoozed", ts, payload });
    }
    this.#onChange(this.#events);
    return { ok: true };
  }

  /** The log as the review list's sink: writes land at once, in the page. */
  sink(): ReviewSink {
    return { send: async (sessionId, request) => this.write(sessionId, request) };
  }
}
