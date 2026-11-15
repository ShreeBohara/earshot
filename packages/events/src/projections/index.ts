import {
  type ProposalStatus,
  type ProposalView,
  proposalsProjection,
  type ReviewView,
} from "./proposals";
import { type SessionView, sessionProjection } from "./session";
import { type UtteranceView, utterancesProjection } from "./utterances";

/** The three projections the `sessions`, `utterances`, and `proposals` tables are built from. */
export const defaultProjections = {
  session: sessionProjection,
  utterances: utterancesProjection,
  proposals: proposalsProjection,
} as const;

export type { Projection } from "./projection";
export {
  type ProposalStatus,
  type ProposalView,
  proposalsProjection,
  type ReviewView,
  type SessionView,
  sessionProjection,
  type UtteranceView,
  utterancesProjection,
};
