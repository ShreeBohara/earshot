// @earshot/understanding restates the contract shapes its corrections and follow-up rules read and
// write instead of importing @earshot/core (whose session tickets need Web Crypto types a DOM-free
// program lacks). This fails to compile if they drift apart: a proposal the correction makes must
// be a `proposal.created` v2 payload (less the id its writer derives), it must read what the
// projection folds, and the follow-up rules' names must be the contract's.

import { LOW_CONFIDENCE_THRESHOLD } from "@earshot/agent";
import type {
  FollowupRule as CoreFollowupRule,
  ProposalCreatedV2,
  UtteranceFinalV3,
} from "@earshot/core";
import { TARGET_FIELD } from "@earshot/core";
import type { ProposalView } from "@earshot/events";
import {
  CORRECTION_LOW_CONFIDENCE,
  CORRECTION_TARGET,
  type CorrectableProposal,
  type CorrectedProposal,
  type CorrectionUtterance,
} from "@earshot/understanding/correct";
import type { FollowupProposal, FollowupRule } from "@earshot/understanding/followups";
import { describe, expect, it } from "vitest";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Within<A, B> = [A] extends [B] ? true : false;

const CONTRACTS_AGREE: [
  Within<CorrectedProposal, Omit<ProposalCreatedV2, "proposalId">>,
  Within<ProposalView, CorrectableProposal>,
  Within<UtteranceFinalV3, CorrectionUtterance>,
  Within<ProposalView, FollowupProposal>,
  Same<FollowupRule, CoreFollowupRule>,
] = [true, true, true, true, true];

describe("the corrections' and follow-ups' types", () => {
  it("restate the contracts' exactly", () => {
    expect(CONTRACTS_AGREE).toEqual([true, true, true, true, true]);
  });

  it("restate the contracts' constants", () => {
    expect(CORRECTION_TARGET).toBe(TARGET_FIELD);
    expect(CORRECTION_LOW_CONFIDENCE).toBe(LOW_CONFIDENCE_THRESHOLD);
  });
});
