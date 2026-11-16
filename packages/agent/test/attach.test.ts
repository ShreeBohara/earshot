import { ProposalCreatedV1 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { attachEvidence } from "../src/attach";
import type { ToolProposal } from "../src/schema";
import {
  DEMO_COMPANY_ID,
  DEMO_DEAL_ID,
  DEMO_ENTITIES,
  DEMO_UTTERANCES,
} from "../src/testing/scenarios";

const context = { utterances: DEMO_UTTERANCES, entities: DEMO_ENTITIES };

function valid(draft: ReturnType<typeof attachEvidence>) {
  if (!draft) throw new Error("expected a draft");
  // Every draft must be a valid proposal.created payload once it has an id.
  return ProposalCreatedV1.parse({ proposalId: "01a1c6e5-0000-7000-8000-000000000001", ...draft });
}

describe("attachEvidence", () => {
  it("turns a quoted task into a proposal.created payload with evidence and a date flag", () => {
    const proposal = valid(
      attachEvidence(
        {
          type: "task",
          target: "acme corp",
          fields: {
            title: {
              value: "Send Dana the pricing breakdown",
              quote: "send Dana the pricing breakdown",
            },
            dueDate: { value: "2026-11-12", quote: "by Thursday" },
          },
        },
        context,
      ),
    );
    expect(proposal).toMatchObject({
      type: "task",
      targetEntityId: DEMO_COMPANY_ID,
      fields: {
        title: { evidence: { span: [10, 41], audioMs: [21150, 23790], confidence: 0.87 } },
        dueDate: { value: "2026-11-12", evidence: { span: [42, 53], audioMs: [23880, 24810] } },
      },
      riskFlags: [{ kind: "date", field: "dueDate" }],
    });
  });

  it("drops a field whose quote isn't in the turn, and flags the proposal unsupported", () => {
    const proposal = valid(
      attachEvidence(
        {
          type: "task",
          target: "Acme Corp",
          fields: {
            title: {
              value: "Send Dana the pricing breakdown",
              quote: "send Dana the pricing breakdown",
            },
            dueDate: { value: "2026-11-13", quote: "by Friday" },
          },
        },
        context,
      ),
    );
    expect(Object.keys(proposal.fields)).toEqual(["title"]);
    expect(proposal.riskFlags).toEqual([{ kind: "unsupported", field: "dueDate" }]);
  });

  it("drops a proposal left with no fields", () => {
    expect(
      attachEvidence(
        {
          type: "note",
          target: "Acme Corp",
          fields: { body: { value: "Renewal at risk", quote: "renewal is at risk" } },
        },
        context,
      ),
    ).toBeNull();
  });

  it("treats an empty value with an empty quote as not said", () => {
    const proposal = valid(
      attachEvidence(
        {
          type: "contact",
          target: null,
          fields: {
            name: { value: "Dana Lee", quote: "Dana Lee" },
            title: { value: "", quote: "" },
            company: null,
            email: { value: " ", quote: "" },
            phone: null,
          },
        },
        context,
      ),
    );
    expect(Object.keys(proposal.fields)).toEqual(["name"]);
    expect(proposal.riskFlags).toEqual([{ kind: "new_entity" }]);
  });

  it("flags a new contact, and resolves a listed one by its name when the target is missing", () => {
    const newContact = valid(
      attachEvidence(
        {
          type: "contact",
          target: null,
          fields: {
            name: { value: "Dana Lee", quote: "Dana Lee" },
            title: null,
            company: null,
            email: null,
            phone: null,
          },
        },
        context,
      ),
    );
    expect(newContact.targetEntityId).toBeNull();
    expect(newContact.riskFlags).toContainEqual({ kind: "new_entity" });

    const listed = valid(
      attachEvidence(
        {
          type: "contact",
          target: null,
          fields: {
            name: { value: "Dana Li", quote: "Dana Lee" },
            title: null,
            company: null,
            email: null,
            phone: null,
          },
        },
        context,
      ),
    );
    expect(listed.targetEntityId).toBe("ct_145");
    expect(listed.riskFlags).not.toContainEqual({ kind: "new_entity" });
  });

  it("targets only the kinds a proposal type allows", () => {
    const update: ToolProposal = {
      type: "deal_update",
      target: "Acme Corp",
      fields: {
        stage: { value: "proposal", quote: "move the deal to the proposal stage" },
        amount: null,
        closeDate: null,
      },
    };
    expect(valid(attachEvidence(update, context)).targetEntityId).toBeNull();
    const onDeal = { ...update, target: "Acme Corp - Security Platform" };
    expect(valid(attachEvidence(onDeal, context)).targetEntityId).toBe(DEMO_DEAL_ID);
  });

  it("keeps a numeric amount and flags it", () => {
    const proposal = valid(
      attachEvidence(
        {
          type: "deal_update",
          target: "Acme Corp - Security Platform",
          fields: {
            stage: null,
            amount: { value: 80000, quote: "move the deal" },
            closeDate: null,
          },
        },
        context,
      ),
    );
    expect(proposal.fields.amount?.value).toBe(80000);
    expect(proposal.riskFlags).toEqual([{ kind: "number", field: "amount" }]);
  });
});
