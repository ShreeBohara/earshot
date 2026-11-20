// The activity feed's typed rows (plan §6: Linear's agent guidelines): actions, responses, errors,
// and connection changes, as distinct row types rather than JSON. Rows come from the session's
// events and issues, from the screen's own log, and from SessionDO's ephemeral `working` messages,
// of which only the newest shows: "Working…" rows replace each other instead of piling up.
import type { ProposalType } from "@earshot/core";
import type { SessionState } from "@earshot/voice/session";
import { SESSION_ISSUE_COPY, turnOutcomeText } from "./copy";

export type ActivityKind = "action" | "response" | "error" | "connection";

export interface ActivityRow {
  /** Stable across renders: an event id, or a local row's own id. */
  readonly id: string;
  readonly kind: ActivityKind;
  readonly text: string;
  /** On the client's clock (`performance.now()`), for ordering. */
  readonly at: number;
  /** A transient row (the "Working…" row), shown last and replaced by the next one. */
  readonly transient?: boolean;
}

/** The newest `working` message as one row, or null when SessionDO isn't working on a turn. */
export function workingRow(state: SessionState): ActivityRow | null {
  let newest: SessionState["working"][string] | undefined;
  for (const view of Object.values(state.working)) {
    if (!newest || view.at > newest.at) newest = view;
  }
  if (!newest) return null;
  const text =
    newest.state === "retrying" && newest.retryInMs !== null
      ? `Retrying in ${Math.max(1, Math.round(newest.retryInMs / 1000))} s…`
      : newest.state === "retrying"
        ? "Retrying…"
        : "Working…";
  return { id: "working", kind: "action", text, at: newest.at, transient: true };
}

/** Rows from the session's folded events and the issues the socket reported. */
export function sessionRows(state: SessionState): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const types = new Map<string, ProposalType>(
    state.projections.proposals.map((proposal) => [proposal.proposalId, proposal.type]),
  );
  state.events.forEach((event, index) => {
    const at = state.receivedAt[index] ?? 0;
    if (event.type === "turn.completed") {
      const { outcome, proposalIds } = event.payload;
      const kinds = proposalIds.flatMap((id) => {
        const type = types.get(id);
        return type ? [type] : [];
      });
      const kind: ActivityKind =
        outcome === "proposals" || outcome === "nothing_to_propose"
          ? "response"
          : outcome === "cancelled"
            ? "action"
            : "error";
      rows.push({ id: event.id, kind, text: turnOutcomeText(outcome, kinds), at });
    } else if (event.type === "session.ended") {
      rows.push({ id: event.id, kind: "action", text: "Session ended.", at });
    }
  });
  state.issues.forEach((issue, index) => {
    if (issue.code === "foreign_event") return;
    rows.push({
      id: `issue-${index}-${issue.at}`,
      kind: "error",
      text: SESSION_ISSUE_COPY[issue.code],
      at: issue.at,
    });
  });
  return rows;
}

/** Every row in order, with the one "Working…" row (if any) last. */
export function deriveActivity(
  state: SessionState | null,
  local: readonly ActivityRow[],
): ActivityRow[] {
  const rows = [...local, ...(state ? sessionRows(state) : [])].sort((a, b) => a.at - b.at);
  const working = state ? workingRow(state) : null;
  return working ? [...rows, working] : rows;
}
