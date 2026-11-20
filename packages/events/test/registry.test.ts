import {
  eventPayloadContracts,
  ProposalCreatedV2,
  ProposalReviewedV2,
  UtteranceFinalV2,
} from "@earshot/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createEventRegistry,
  defaultRegistry,
  EventValidationError,
  latestVersions,
  proposalCreatedV1ToV2,
  proposalReviewedV1ToV2,
  UnknownEventError,
  UpcastError,
  type Upcaster,
  utteranceFinalV1ToV2,
} from "../src";
import {
  deepFreeze,
  envelope,
  proposal,
  proposalFlagged,
  proposalV2,
  reopen,
  review,
  reviewV2,
  sealed,
  snoozed,
  turnCompleted,
  turnMeasured,
  turnWitnessed,
  usageRecorded,
  utterance,
  utteranceV1,
  uuid,
} from "./helpers";

describe("utteranceFinalV1ToV2", () => {
  const v1 = envelope(utteranceV1(1, "Met Dana Lee at Acme."));

  it("sets witness to biased and moves the event to v2, keeping everything else", () => {
    expect(utteranceFinalV1ToV2.up(v1)).toEqual({
      ...v1,
      schemaVersion: 2,
      payload: { ...v1.payload, witness: "biased" },
    });
  });

  it("produces a payload the v2 schema accepts", () => {
    expect(UtteranceFinalV2.safeParse(utteranceFinalV1ToV2.up(v1).payload).success).toBe(true);
  });

  it("doesn't mutate the event it upcasts", () => {
    const frozen = deepFreeze(structuredClone(v1));
    utteranceFinalV1ToV2.up(frozen);
    expect(frozen).toEqual(v1);
  });
});

describe("proposalCreatedV1ToV2", () => {
  const unknownTarget = {
    kind: null,
    basis: null,
    p: null,
    mention: null,
    company: null,
    candidates: [],
  };
  /** A v1 proposal of `type`, with `targetEntityId` and `riskFlags` set. */
  const v1 = (type: string, targetEntityId: string | null, riskFlags: unknown[] = []) => {
    const body = proposal(1, type);
    Object.assign(body.payload, { targetEntityId, riskFlags });
    return envelope(body);
  };
  /** What the upcaster should make of `event`: v2, with `target`, and fields and flags as they were. */
  const expected = (event: ReturnType<typeof v1>, target: Record<string, unknown>) => {
    const { targetEntityId: _, ...rest } = event.payload;
    return {
      ...event,
      schemaVersion: 2,
      payload: { ...rest, target, supersedes: null, linker: null },
    };
  };

  it("links a v1 target on an exact basis, since v1 matched only exact names and aliases", () => {
    const linked = v1("task", uuid(6001), [{ kind: "date", field: "title" }]);
    expect(proposalCreatedV1ToV2.up(linked)).toEqual(
      expected(linked, {
        ...unknownTarget,
        decision: "linked",
        entityId: uuid(6001),
        basis: "exact",
      }),
    );
  });

  it("makes a new contact's missing target new, from its new_entity flag", () => {
    const newContact = v1("contact", null, [{ kind: "new_entity" }]);
    expect(proposalCreatedV1ToV2.up(newContact)).toEqual(
      expected(newContact, { ...unknownTarget, decision: "new", entityId: null }),
    );
  });

  it("makes a note with no target none", () => {
    const note = v1("note", null, [{ kind: "low_confidence" }]);
    expect(proposalCreatedV1ToV2.up(note)).toEqual(
      expected(note, { ...unknownTarget, decision: "none", entityId: null }),
    );
  });

  it("produces payloads the v2 schema accepts", () => {
    for (const event of [
      v1("task", uuid(6001)),
      v1("contact", null, [{ kind: "new_entity" }]),
      v1("note", null),
      v1("deal_update", "hubspot:deal:42", [{ kind: "new_entity" }, { kind: "witness_conflict" }]),
    ]) {
      const result = ProposalCreatedV2.safeParse(proposalCreatedV1ToV2.up(event).payload);
      expect(result.error?.issues ?? []).toEqual([]);
    }
  });

  it("doesn't mutate the event it upcasts", () => {
    const event = v1("task", uuid(6001), [{ kind: "date", field: "title" }]);
    const frozen = deepFreeze(structuredClone(event));
    proposalCreatedV1ToV2.up(frozen);
    expect(frozen).toEqual(event);
  });
});

describe("proposalReviewedV1ToV2", () => {
  /** What the upcaster should make of a v1 review: v2, its own id as the review id, single. */
  const expected = (event: ReturnType<typeof envelope>, decision: string, extra = {}) => ({
    ...event,
    schemaVersion: 2,
    payload: {
      reviewId: event.id,
      proposalId: uuid(3001),
      decision,
      target: null,
      ...extra,
      mode: "single",
      batchId: null,
      policy: null,
      undoes: null,
      reason: null,
      seen: null,
      timing: { decisionMs: 1500, handlingMs: 1500 },
      input: null,
      surface: null,
      syncEligibleAt: null,
      by: null,
    },
  });

  it("upcasts an approval: its event id as the review id, and reviewerMs as both timings", () => {
    const approved = envelope(review(1, "approved"));
    expect(proposalReviewedV1ToV2.up(approved)).toEqual(expected(approved, "approved"));
  });

  it("carries an edit's diff over", () => {
    const editDiff = { title: { before: "Send the deck", after: "Send the revised deck" } };
    const edited = envelope(review(1, "edited", { editDiff }));
    expect(proposalReviewedV1ToV2.up(edited)).toEqual(expected(edited, "edited", { editDiff }));
  });

  it("upcasts a rejection, with no diff and nothing eligible to sync", () => {
    const rejected = envelope(review(1, "rejected"));
    const up = proposalReviewedV1ToV2.up(rejected);
    expect(up).toEqual(expected(rejected, "rejected"));
    expect(up.payload).not.toHaveProperty("editDiff");
  });

  it("produces payloads the v2 schema accepts", () => {
    for (const event of [
      envelope(review(1, "approved", { reviewerMs: 0 })),
      envelope(
        review(1, "edited", { editDiff: { dueDate: { before: null, after: "2026-11-12" } } }),
      ),
      envelope(review(1, "rejected", { reviewerMs: Number.MAX_SAFE_INTEGER })),
    ]) {
      const result = ProposalReviewedV2.safeParse(proposalReviewedV1ToV2.up(event).payload);
      expect(result.error?.issues ?? []).toEqual([]);
    }
  });

  it("is deterministic and doesn't mutate the event it upcasts", () => {
    const event = envelope(review(1, "edited", { editDiff: { a: { before: 1, after: 2 } } }));
    const frozen = deepFreeze(structuredClone(event));
    expect(proposalReviewedV1ToV2.up(frozen)).toEqual(proposalReviewedV1ToV2.up(event));
    expect(frozen).toEqual(event);
  });
});

describe("defaultRegistry", () => {
  it("upcasts a stored v1 utterance to the latest version", () => {
    const v1 = envelope(utteranceV1(1));
    const latest = defaultRegistry.toLatest(v1);
    expect(latest.schemaVersion).toBe(2);
    expect(latest.payload).toEqual({ ...v1.payload, witness: "biased" });
  });

  it("upcasts a stored v1 proposal to v2, and leaves a v2 proposal as it is", () => {
    const stored = envelope(proposal(1));
    const latest = defaultRegistry.toLatest(stored);
    expect(latest).toMatchObject({ schemaVersion: 2, payload: { target: { decision: "none" } } });
    expect(latest.payload).not.toHaveProperty("targetEntityId");
    const v2 = envelope(proposalV2(1));
    expect(defaultRegistry.toLatest(v2)).toBe(v2);
  });

  it("validates a v2 proposal against v2, and refuses v1's shape at v2", () => {
    const v1AtV2 = envelope({ ...proposal(1), schemaVersion: 2 });
    expect(() => defaultRegistry.toLatest(v1AtV2)).toThrow(EventValidationError);
    const v2AtV1 = envelope({ ...proposalV2(1), schemaVersion: 1 });
    expect(() => defaultRegistry.toLatest(v2AtV1)).toThrow(EventValidationError);
  });

  it("fails when it loads, not on replay, if proposal.created v1 loses its upcaster", () => {
    expect(() =>
      createEventRegistry({ payloads: eventPayloadContracts, upcasters: [utteranceFinalV1ToV2] }),
    ).toThrow(/proposal.created v1 has no upcaster to v2/);
    expect(() =>
      createEventRegistry({ payloads: eventPayloadContracts, upcasters: [proposalCreatedV1ToV2] }),
    ).toThrow(UpcastError);
  });

  it("fails when it loads, not on replay, if proposal.reviewed v1 loses its upcaster", () => {
    expect(() =>
      createEventRegistry({
        payloads: eventPayloadContracts,
        upcasters: [utteranceFinalV1ToV2, proposalCreatedV1ToV2],
      }),
    ).toThrow(/proposal.reviewed v1 has no upcaster to v2/);
  });

  it("upcasts a stored v1 review to v2, and leaves a v2 review as it is", () => {
    const stored = envelope(review(1, "approved"));
    expect(defaultRegistry.toLatest(stored)).toMatchObject({
      schemaVersion: 2,
      payload: { reviewId: stored.id, mode: "single", syncEligibleAt: null },
    });
    const v2 = envelope(reviewV2(1));
    expect(defaultRegistry.toLatest(v2)).toBe(v2);
  });

  it("validates a v2 review against v2, and refuses v1's shape at v2", () => {
    const v1AtV2 = envelope({ ...review(1, "approved"), schemaVersion: 2 });
    expect(() => defaultRegistry.toLatest(v1AtV2)).toThrow(EventValidationError);
    const v2AtV1 = envelope({ ...reviewV2(1), schemaVersion: 1 });
    expect(() => defaultRegistry.toLatest(v2AtV1)).toThrow(EventValidationError);
    const reopenAtV1 = envelope({ ...reopen(1, uuid(7001)), schemaVersion: 1 });
    expect(() => defaultRegistry.toLatest(reopenAtV1)).toThrow(EventValidationError);
  });

  it("returns an event already at the latest version as is", () => {
    const v2 = envelope(utterance(1));
    expect(defaultRegistry.toLatest(v2)).toBe(v2);
  });

  it("knows the latest version of every event type, matching SessionEvent", () => {
    const types = new Set(eventPayloadContracts.map(({ type }) => type));
    expect([...types].sort()).toEqual(Object.keys(latestVersions).sort());
    for (const [type, version] of Object.entries(latestVersions)) {
      expect(defaultRegistry.latestVersion(type)).toBe(version);
    }
  });

  it("validates a payload against its own version, not the latest", () => {
    const v1WithWitness = envelope({ ...utteranceV1(1), payload: utterance(1).payload });
    expect(() => defaultRegistry.toLatest(v1WithWitness)).toThrow(EventValidationError);
  });

  it("rejects an unknown type and a version newer than it knows", () => {
    const unknown = envelope({ type: "followup.asked", schemaVersion: 1, payload: {} });
    expect(() => defaultRegistry.toLatest(unknown)).toThrow(UnknownEventError);
    const v3 = envelope({ ...utterance(1), schemaVersion: 3 });
    expect(() => defaultRegistry.toLatest(v3)).toThrow(
      /newer than this reader knows \(latest is v2\)/,
    );
  });
});

describe("the Phase 3 event types", () => {
  const bodies = [usageRecorded(1), turnCompleted(1), turnMeasured(1)];

  it.each(bodies)("$type loads at v1, its latest version", (body) => {
    expect(defaultRegistry.latestVersion(body.type)).toBe(1);
    expect(defaultRegistry.payloadSchema(body.type, 1)).toBeDefined();
    const event = envelope(body);
    expect(defaultRegistry.toLatest(event)).toBe(event);
  });

  it("validates their payloads", () => {
    for (const bad of [
      usageRecorded(1, { costUsd: -0.01 }),
      usageRecorded(1, { priceTable: "2026-11-15T00:00:00Z" }),
      turnCompleted(1, { outcome: "timeout" }),
      turnCompleted(1, { attempts: 0.5 }),
      turnMeasured(1, { mode: "ptt" }),
      turnMeasured(1, { totalMs: -1 }),
    ]) {
      expect(() => defaultRegistry.toLatest(envelope(bad))).toThrow(EventValidationError);
    }
  });
});

describe("the Phase 4 event types", () => {
  const bodies = [proposalFlagged(1), turnWitnessed(1)];

  it.each(bodies)("$type loads at v1, its latest version", (body) => {
    expect(defaultRegistry.latestVersion(body.type)).toBe(1);
    const event = envelope(body);
    expect(defaultRegistry.toLatest(event)).toBe(event);
  });

  it("validates their payloads", () => {
    for (const bad of [
      proposalFlagged(1, { flags: [] }),
      proposalFlagged(1, { source: "linker" }),
      proposalFlagged(1, { target: { decision: "linked", candidates: [] } }),
      turnWitnessed(1, { outcome: "transcribed" }),
      turnWitnessed(1, { conflicts: -1 }),
      turnWitnessed(1, { reason: "cancelled" }),
    ]) {
      expect(() => defaultRegistry.toLatest(envelope(bad))).toThrow(EventValidationError);
    }
  });
});

describe("the Phase 5 event types", () => {
  const bodies = [snoozed(1), snoozed(1, null), sealed(), sealed({ by: "import" })];

  it.each(bodies)("$type loads at v1, its latest version", (body) => {
    expect(defaultRegistry.latestVersion(body.type)).toBe(1);
    const event = envelope(body);
    expect(defaultRegistry.toLatest(event)).toBe(event);
  });

  it("validates their payloads, and v2 reviews'", () => {
    for (const bad of [
      snoozed(1, "tomorrow"),
      snoozed(1, null, { by: null }),
      snoozed(1, null, { snoozeId: "snooze-1" }),
      sealed({ by: "edge" }),
      sealed({ sealedAt: "2026-11-10T19:16:40" }),
      reviewV2(1, "approved", { mode: "auto" }),
      reviewV2(1, "approved", { timing: { decisionMs: 1.5, handlingMs: 2 } }),
      reviewV2(1, "approved", { reviewerMs: 1500 }),
    ]) {
      expect(() => defaultRegistry.toLatest(envelope(bad))).toThrow(EventValidationError);
    }
  });
});

describe("createEventRegistry", () => {
  // A made-up event type with three versions: one name, then first and last, then a source.
  const heardV1 = {
    type: "contact.heard",
    schemaVersion: 1,
    schema: z.strictObject({ name: z.string() }),
  };
  const payloads = [
    heardV1,
    {
      type: "contact.heard",
      schemaVersion: 2,
      schema: z.strictObject({ firstName: z.string(), lastName: z.string() }),
    },
    {
      type: "contact.heard",
      schemaVersion: 3,
      schema: z.strictObject({
        firstName: z.string(),
        lastName: z.string(),
        source: z.enum(["rep", "crm"]),
      }),
    },
  ];
  const splitName: Upcaster = {
    type: "contact.heard",
    fromVersion: 1,
    up: (event) => {
      const [firstName = "", ...rest] = String(event.payload.name).split(" ");
      return { ...event, schemaVersion: 2, payload: { firstName, lastName: rest.join(" ") } };
    },
  };
  const addSource: Upcaster = {
    type: "contact.heard",
    fromVersion: 2,
    up: (event) => ({ ...event, schemaVersion: 3, payload: { ...event.payload, source: "rep" } }),
  };
  const heard = envelope({
    type: "contact.heard",
    schemaVersion: 1,
    payload: { name: "Dana Lee" },
  });

  it("chains upcasters one version at a time, in any registration order", () => {
    const registry = createEventRegistry({ payloads, upcasters: [addSource, splitName] });
    expect(registry.latestVersion("contact.heard")).toBe(3);
    expect(registry.toLatest(heard)).toEqual({
      ...heard,
      schemaVersion: 3,
      payload: { firstName: "Dana", lastName: "Lee", source: "rep" },
    });
    const v2 = splitName.up(heard);
    expect(registry.toLatest(v2).payload).toEqual({
      firstName: "Dana",
      lastName: "Lee",
      source: "rep",
    });
  });

  it("refuses a chain with a missing link", () => {
    expect(() => createEventRegistry({ payloads, upcasters: [splitName] })).toThrow(
      /contact.heard v2 has no upcaster to v3/,
    );
  });

  it("refuses an upcaster for a version that isn't registered", () => {
    const toV4: Upcaster = { ...addSource, fromVersion: 3 };
    expect(() =>
      createEventRegistry({ payloads, upcasters: [splitName, addSource, toV4] }),
    ).toThrow(UpcastError);
  });

  it("refuses a (type, schemaVersion) registered twice", () => {
    expect(() => createEventRegistry({ payloads: [...payloads, heardV1] })).toThrow(
      /registered twice/,
    );
  });

  it("rejects an upcaster that skips a version", () => {
    const skips: Upcaster = {
      ...splitName,
      up: (event) => ({ ...addSource.up(splitName.up(event)), schemaVersion: 3 }),
    };
    const registry = createEventRegistry({ payloads, upcasters: [skips, addSource] });
    expect(() => registry.toLatest(heard)).toThrow(UpcastError);
  });

  it("rejects an upcaster that changes the envelope", () => {
    const moves: Upcaster = { ...splitName, up: (event) => ({ ...splitName.up(event), seq: 7 }) };
    const registry = createEventRegistry({ payloads, upcasters: [moves, addSource] });
    expect(() => registry.toLatest(heard)).toThrow(/changing only schemaVersion and payload/);
  });

  it("rejects an upcaster whose output the newer schema refuses", () => {
    const loses: Upcaster = { ...addSource, up: (event) => ({ ...event, schemaVersion: 3 }) };
    const registry = createEventRegistry({ payloads, upcasters: [splitName, loses] });
    expect(() => registry.toLatest(heard)).toThrow(/upcasted payload is invalid at v3/);
  });
});
