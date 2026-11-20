// Who the pilot page is for (Phase 5 spec WP7 step 2): `?p=1` to `?p=5` are participants P1 to P5,
// each with an order of their own; `?p=ci` is the scripted reviewer's (WP8). Anything else gets
// no order, and the page asks for a number instead of starting.

/** The participants the set has orders for. */
export const PILOT_PARTICIPANTS = ["1", "2", "3", "4", "5"] as const;

/** A participant: the results file's label, and the key of their order in the manifest. */
export interface PilotParticipant {
  readonly label: string;
  readonly key: string;
}

export function participantOf(p: string | null | undefined): PilotParticipant | null {
  if (p === "ci") return { label: "ci", key: "ci" };
  if ((PILOT_PARTICIPANTS as readonly string[]).includes(p ?? "")) {
    return { label: `P${p}`, key: p as string };
  }
  return null;
}
