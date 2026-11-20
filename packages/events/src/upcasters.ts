import type {
  ProposalCreatedV1,
  ProposalCreatedV2,
  ProposalReviewedV1,
  ProposalReviewedV2,
  TargetV2,
} from "@earshot/core";
import type { Upcaster } from "./types";

/**
 * `utterance.final` v1 → v2. Version 1 predates the second witness: every v1 utterance came from
 * the keyterm-biased speech-to-text stream, so it upcasts with `witness: "biased"`.
 */
export const utteranceFinalV1ToV2: Upcaster = {
  type: "utterance.final",
  fromVersion: 1,
  up: (event) => ({
    ...event,
    schemaVersion: 2,
    payload: { ...event.payload, witness: "biased" },
  }),
};

/**
 * `proposal.created` v1 → v2 (Phase 4 spec §4.1). v1 named its target by id alone, and matched
 * only exact names and aliases, so:
 * - a `targetEntityId` becomes a target `linked` on an `exact` basis, with no probability, mention,
 *   company, or candidates, which v1 never recorded;
 * - no `targetEntityId` becomes `new` when v1 flagged `new_entity`, and `none` otherwise.
 *
 * Fields and flags carry over unchanged, since v1's risk kinds are a subset of v2's. `supersedes`
 * and `linker` are null: v1 had no follow-ups and no linker.
 */
export const proposalCreatedV1ToV2: Upcaster = {
  type: "proposal.created",
  fromVersion: 1,
  up: (event) => {
    // The registry validates the event at v1 before it upcasts it.
    const { targetEntityId, ...rest } = event.payload as ProposalCreatedV1;
    const target: TargetV2 =
      targetEntityId === null
        ? {
            decision: rest.riskFlags.some((flag) => flag.kind === "new_entity") ? "new" : "none",
            entityId: null,
            kind: null,
            basis: null,
            p: null,
            mention: null,
            company: null,
            candidates: [],
          }
        : {
            decision: "linked",
            entityId: targetEntityId,
            kind: null,
            basis: "exact",
            p: null,
            mention: null,
            company: null,
            candidates: [],
          };
    const payload: ProposalCreatedV2 = { ...rest, target, supersedes: null, linker: null };
    return { ...event, schemaVersion: 2, payload };
  },
};

/**
 * `proposal.reviewed` v1 → v2 (Phase 5 spec §4.1). A v1 review was a person's decision on one
 * card, with one time, so:
 * - `reviewId` is the event's own id, which keeps the upcast deterministic and gives a later
 *   reopen something to name;
 * - `decision` and `editDiff` carry over, and `reviewerMs` becomes both of the review clock's
 *   times, `decisionMs` and `handlingMs`;
 * - the mode is `single`, and everything v1 never recorded is null: the record chosen, the batch,
 *   the policy, what was undone and why, what the reviewer saw, the input, the surface, and who
 *   reviewed. So is `syncEligibleAt`: nothing upcast from v1 is eligible to sync.
 */
export const proposalReviewedV1ToV2: Upcaster = {
  type: "proposal.reviewed",
  fromVersion: 1,
  up: (event) => {
    // The registry validates the event at v1 before it upcasts it.
    const { proposalId, decision, editDiff, reviewerMs } = event.payload as ProposalReviewedV1;
    const payload: ProposalReviewedV2 = {
      reviewId: event.id,
      proposalId,
      decision,
      target: null,
      ...(editDiff === undefined ? {} : { editDiff }),
      mode: "single",
      batchId: null,
      policy: null,
      undoes: null,
      reason: null,
      seen: null,
      timing: { decisionMs: reviewerMs, handlingMs: reviewerMs },
      input: null,
      surface: null,
      syncEligibleAt: null,
      by: null,
    };
    return { ...event, schemaVersion: 2, payload };
  },
};

/** Every upcaster Earshot ships, in no particular order: the registry chains them by version. */
export const upcasters: readonly Upcaster[] = [
  utteranceFinalV1ToV2,
  proposalCreatedV1ToV2,
  proposalReviewedV1ToV2,
];
