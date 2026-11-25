import {
  type FollowupStatus,
  type FollowupView,
  type ProposalStatus,
  type ProposalView,
  proposalsProjection,
  type ReviewView,
  type SyncConflict,
  type SyncFailure,
  type SyncState,
  type SyncView,
} from "./proposals";
import { recapProblem, type SessionRecap, type SessionView, sessionProjection } from "./session";
import { type UtteranceView, utterancesProjection } from "./utterances";

/** The three projections the `sessions`, `utterances`, and `proposals` tables are built from. */
export const defaultProjections = {
  session: sessionProjection,
  utterances: utterancesProjection,
  proposals: proposalsProjection,
} as const;

export type { Projection } from "./projection";
export {
  type FollowupStatus,
  type FollowupView,
  type ProposalStatus,
  type ProposalView,
  proposalsProjection,
  type ReviewView,
  recapProblem,
  type SessionRecap,
  type SessionView,
  type SyncConflict,
  type SyncFailure,
  type SyncState,
  type SyncView,
  sessionProjection,
  type UtteranceView,
  utterancesProjection,
};
