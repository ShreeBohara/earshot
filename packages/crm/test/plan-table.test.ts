// What each proposal writes (Phase 6 spec §4.3): `buildPlan` reads §4.3's table with an adapter's
// column. A plain test column names every property after its value, so the rows show through.
import type { CrmMapping } from "@earshot/core";
import { describe, expect, it } from "vitest";
import {
  activityLine,
  buildPlan,
  type Capabilities,
  type CrmSchema,
  type CrmValue,
  type PlanColumn,
  type PlanInput,
} from "../src";
import { mirrorRef, PROPOSED_AT, planInput, proposalView, reviewView } from "../src/testing";

const MARKERS = [
  "es_aaaaaaaaaaaaaaaaaaaa",
  "es_bbbbbbbbbbbbbbbbbbbb",
  "es_cccccccccccccccccccc",
  "es_dddddddddddddddddddd",
  "es_eeeeeeeeeeeeeeeeeeee",
  "es_ffffffffffffffffffff",
  "es_gggggggggggggggggggg",
  "es_hhhhhhhhhhhhhhhhhhhh",
];
const [M0, M1, M2, M3] = MARKERS as [string, string, string, string];
const KEY = "a".repeat(64);

const CAPABILITIES: Capabilities = {
  objects: { company: true, contact: true, deal: true, note: true, task: true, meeting: true },
  idempotency: { records: "upsert", activities: "readback" },
  associations: "inline",
  changes: "modified_since",
  webhooks: false,
  owners: true,
  attribution: "key",
};

/** Every record kind to every other, and every activity to every record kind, as `link`. */
const SCHEMA: CrmSchema = {
  stages: [],
  owners: [{ ownerId: "o_rep", email: "rep@example.test", name: "Rep" }],
  associations: [
    { from: "contact", to: "company", type: "contact_company" },
    { from: "deal", to: "company", type: "deal_company" },
    ...(["note", "task", "meeting"] as const).flatMap((from) =>
      (["company", "contact", "deal"] as const).map((to) => ({ from, to, type: `${from}_${to}` })),
    ),
  ],
  properties: [],
};

const MAPPING: CrmMapping = {
  v: 1,
  stages: [
    { stageId: "s_disc", pipelineId: "sales", label: "Discovery", words: [] },
    { stageId: "s_prop", pipelineId: "sales", label: "Proposal", words: ["sent the proposal"] },
    { stageId: "s_neg", pipelineId: "sales", label: "Negotiation", words: [] },
    { stageId: "r_disc", pipelineId: "renewals", label: "Renewal review", words: [] },
  ],
  newDeals: { pipelineId: "sales" },
  owners: [{ userId: "u_rep", ownerId: "o_rep" }],
  destinations: { commitment: "task", meeting: "meeting" },
};

/** The properties without the values a write doesn't hold, as a CRM takes them. */
function defined(values: Readonly<Record<string, CrmValue | undefined>>): Record<string, CrmValue> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, CrmValue] => entry[1] !== undefined),
  );
}

function column(capabilities: Capabilities = CAPABILITIES): PlanColumn {
  return {
    crm: "Testing CRM",
    capabilities,
    properties(draft, marker) {
      const made = draft.op === "create" ? { write_id: marker } : {};
      switch (draft.object) {
        case "company":
          return { name: draft.values.name, write_id: marker };
        case "contact":
          return defined({ ...draft.values, ...made });
        case "deal": {
          const { stage, ...rest } = draft.values;
          return defined({ ...rest, stage: stage?.stageId, ...made });
        }
        case "note":
          return { body: draft.values.body, at: draft.values.at };
        case "task":
          return { ...draft.values };
        case "meeting":
          return { ...draft.values };
      }
    },
    checkField: (object, field) => `${object}.${field}`,
  };
}

const ACME = mirrorRef({ object: "company", id: "c_100", url: null }, "Acme", "e_acme");
const DANA = mirrorRef({ object: "contact", id: "p_200", url: null }, "Dana Lee", "e_dana");
const RENEWAL = mirrorRef({ object: "deal", id: "d_300", url: null }, "Acme renewal", "e_renewal");

function input(parts: Partial<PlanInput> & Pick<PlanInput, "proposal">): PlanInput {
  return {
    ...planInput({ mapping: MAPPING, schema: SCHEMA, key: KEY, markers: MARKERS, ...parts }),
    ...parts,
  };
}

describe("buildPlan: activities", () => {
  it("puts a note on a linked record, ending with the activity line", () => {
    const proposal = proposalView(
      "note",
      { body: "Dana wants the security review first." },
      { linked: RENEWAL },
    );
    expect(buildPlan(input({ proposal, target: RENEWAL }), column())).toEqual({
      ok: true,
      plan: {
        v: 1,
        checks: [],
        writes: [
          {
            index: 0,
            op: "create",
            object: "note",
            marker: M0,
            ref: null,
            properties: {
              body: `Dana wants the security review first.\n\n${activityLine(M0)}`,
              at: PROPOSED_AT,
            },
            associate: [{ to: RENEWAL.ref, type: "note_deal" }],
          },
        ],
      },
    });
  });

  it("makes a new record first, and points the activity at it", () => {
    const proposal = proposalView(
      "note",
      { body: "Met their CFO." },
      { new: { kind: "company", words: "Northwind Foods" } },
    );
    const result = buildPlan(input({ proposal }), column());
    expect(result.ok && result.plan.writes).toEqual([
      {
        index: 0,
        op: "create",
        object: "company",
        marker: M0,
        ref: null,
        properties: { name: "Northwind Foods", write_id: M0 },
        associate: [],
      },
      {
        index: 1,
        op: "create",
        object: "note",
        marker: M1,
        ref: null,
        properties: { body: `Met their CFO.\n\n${activityLine(M1)}`, at: PROPOSED_AT },
        associate: [{ to: { write: 0 }, type: "note_company" }],
      },
    ]);
  });

  it("links a new contact target to its company, and splits its name", () => {
    const proposal = proposalView(
      "task",
      { title: "Call her back" },
      { new: { kind: "contact", words: "Priya Raman" } },
    );
    const result = buildPlan(input({ proposal, company: ACME }), column());
    expect(
      result.ok &&
        result.plan.writes.map((write) => [write.object, write.properties, write.associate]),
    ).toEqual([
      [
        "contact",
        { name: "Priya Raman", firstName: "Priya", lastName: "Raman", write_id: M0 },
        [{ to: ACME.ref, type: "contact_company" }],
      ],
      [
        "task",
        {
          title: "Call her back",
          body: activityLine(M1),
          dueAt: PROPOSED_AT,
          dueDate: null,
          ownerId: null,
        },
        [{ to: { write: 0 }, type: "task_contact" }],
      ],
    ]);
  });

  it("dues a task at 09:00 in the rep's zone, assigned to the rep, or at the proposal's time with no date", () => {
    const proposal = proposalView(
      "task",
      { title: "Send the revised pricing", dueDate: "2026-12-04" },
      { linked: DANA },
    );
    const rep = { ownerId: "o_rep", timeZone: "America/Chicago" };
    const result = buildPlan(input({ proposal, target: DANA, rep }), column());
    expect(result.ok && result.plan.writes[0]?.properties).toEqual({
      title: "Send the revised pricing",
      body: activityLine(M0),
      dueAt: "2026-12-04T15:00:00.000Z",
      dueDate: "2026-12-04",
      ownerId: "o_rep",
    });
    const unknownZone = buildPlan(
      input({ proposal, target: DANA, rep: { ownerId: null, timeZone: "Nowhere/Land" } }),
      column(),
    );
    expect(unknownZone.ok && unknownZone.plan.writes[0]?.properties.dueAt).toBe(
      "2026-12-04T09:00:00.000Z",
    );
    const noOwners = buildPlan(
      input({ proposal, target: DANA, rep }),
      column({ ...CAPABILITIES, owners: false }),
    );
    expect(noOwners.ok && noOwners.plan.writes[0]?.properties.ownerId).toBeNull();
  });

  it("writes a commitment as a task when it's due and the mapping says tasks, else as a note", () => {
    const due = proposalView(
      "commitment",
      { text: "Share the SOC 2 report", counterpart: "Dana", dueDate: "2026-12-01" },
      { linked: DANA },
    );
    const asTask = buildPlan(input({ proposal: due, target: DANA }), column());
    expect(asTask.ok && asTask.plan.writes[0]).toMatchObject({
      object: "task",
      properties: {
        title: "Commitment: Share the SOC 2 report",
        body: `Counterpart: Dana\n\n${activityLine(M0)}`,
        dueAt: "2026-12-01T15:00:00.000Z",
      },
    });
    const undated = proposalView(
      "commitment",
      { text: "Share the SOC 2 report" },
      { linked: DANA },
    );
    const asNote = buildPlan(input({ proposal: undated, target: DANA }), column());
    expect(asNote.ok && asNote.plan.writes[0]).toMatchObject({
      object: "note",
      properties: { body: `Commitment: Share the SOC 2 report\n\n${activityLine(M0)}` },
    });
    const toNotes = {
      ...MAPPING,
      destinations: { commitment: "note", meeting: "meeting" },
    } as const;
    const byMapping = buildPlan(input({ proposal: due, target: DANA, mapping: toNotes }), column());
    expect(byMapping.ok && byMapping.plan.writes[0]).toMatchObject({
      object: "note",
      properties: {
        body: `Commitment: Share the SOC 2 report\nCounterpart: Dana\nDue: 2026-12-01\n\n${activityLine(M0)}`,
      },
    });
  });

  it("writes a meeting at its date and time in the zone, or as a note where the CRM has none", () => {
    const proposal = proposalView(
      "meeting",
      {
        title: "Security review",
        date: "2026-12-03",
        time: "14:30",
        attendees: "Dana and their CISO",
      },
      { linked: ACME },
    );
    const meeting = buildPlan(input({ proposal, target: ACME }), column());
    expect(meeting.ok && meeting.plan.writes[0]).toMatchObject({
      object: "meeting",
      properties: {
        title: "Security review",
        body: `Attendees: Dana and their CISO\n\n${activityLine(M0)}`,
        startsAt: "2026-12-03T20:30:00.000Z",
      },
      associate: [{ to: ACME.ref, type: "meeting_company" }],
    });
    const noMeetings = { ...CAPABILITIES, objects: { ...CAPABILITIES.objects, meeting: false } };
    const asNote = buildPlan(input({ proposal, target: ACME }), column(noMeetings));
    expect(asNote.ok && asNote.plan.writes[0]).toMatchObject({
      object: "note",
      properties: {
        body: `Meeting: Security review\nWhen: 2026-12-03 14:30 (America/Chicago)\nAttendees: Dana and their CISO\n\n${activityLine(M0)}`,
      },
    });
    const undated = proposalView(
      "meeting",
      { title: "Kickoff", date: "2026-12-03" },
      { linked: ACME },
    );
    const atNine = buildPlan(input({ proposal: undated, target: ACME }), column());
    expect(atNine.ok && atNine.plan.writes[0]?.properties.startsAt).toBe(
      "2026-12-03T15:00:00.000Z",
    );
  });

  it("makes each record's associations a write of their own when the CRM takes them separately", () => {
    const separate: Capabilities = { ...CAPABILITIES, associations: "separate" };
    const proposal = proposalView(
      "note",
      { body: "Intro call." },
      { new: { kind: "contact", words: "Priya Raman" } },
    );
    const result = buildPlan(input({ proposal, company: ACME }), column(separate));
    expect(
      result.ok &&
        result.plan.writes.map(({ index, op, object, marker, ref, associate }) => ({
          index,
          op,
          object,
          marker,
          ref,
          associate,
        })),
    ).toEqual([
      { index: 0, op: "create", object: "contact", marker: M0, ref: null, associate: [] },
      {
        index: 1,
        op: "associate",
        object: "contact",
        marker: M1,
        ref: { write: 0 },
        associate: [{ to: ACME.ref, type: "contact_company" }],
      },
      { index: 2, op: "create", object: "note", marker: M2, ref: null, associate: [] },
      {
        index: 3,
        op: "associate",
        object: "note",
        marker: M3,
        ref: { write: 2 },
        associate: [{ to: { write: 0 }, type: "note_contact" }],
      },
    ]);
    // The note's line carries its own write's marker.
    expect(result.ok && result.plan.writes[2]?.properties.body).toBe(
      `Intro call.\n\n${activityLine(M2)}`,
    );
  });
});

describe("buildPlan: records", () => {
  it("makes a new contact with its details, linked to its company", () => {
    const proposal = proposalView(
      "contact",
      {
        name: "Dana Lee",
        title: "VP of Operations",
        email: "dana@acme.example",
        phone: "555-0142",
        company: "Acme",
      },
      { none: true },
    );
    const result = buildPlan(input({ proposal, company: ACME }), column());
    expect(result.ok && result.plan).toEqual({
      v: 1,
      checks: [],
      writes: [
        {
          index: 0,
          op: "create",
          object: "contact",
          marker: M0,
          ref: null,
          properties: {
            name: "Dana Lee",
            firstName: "Dana",
            lastName: "Lee",
            title: "VP of Operations",
            email: "dana@acme.example",
            phone: "555-0142",
            write_id: M0,
          },
          associate: [{ to: ACME.ref, type: "contact_company" }],
        },
      ],
    });
  });

  it("updates a linked contact's details, checking each against what the reviewer saw", () => {
    const proposal = proposalView(
      "contact",
      { name: "Dana Lee", title: "COO", email: "dana@acme.example" },
      { linked: DANA },
    );
    const review = reviewView({
      seen: {
        title: { proposed: "COO", base: "VP of Operations" },
        email: {
          proposed: "dana@acme.example",
          base: "dana@old.example",
          current: "dana@new.example",
        },
      },
    });
    const result = buildPlan(input({ proposal, review, target: DANA }), column());
    expect(result).toEqual({
      ok: true,
      plan: {
        v: 1,
        checks: [
          { ref: DANA.ref, field: "title", crmField: "contact.title", seen: "VP of Operations" },
          { ref: DANA.ref, field: "email", crmField: "contact.email", seen: "dana@new.example" },
        ],
        writes: [
          {
            index: 0,
            op: "update",
            object: "contact",
            marker: M0,
            ref: DANA.ref,
            properties: { title: "COO", email: "dana@acme.example" },
            associate: [],
          },
        ],
      },
    });
  });

  it("updates a linked deal with the stage the mapping reads, the reviewer's edits, and nothing emptied", () => {
    const proposal = proposalView(
      "deal_update",
      { stage: "sent the proposal", amount: 40_000, closeDate: "2026-12-15" },
      { linked: RENEWAL },
    );
    const review = reviewView({
      editDiff: {
        amount: { before: 40_000, after: 48_000 },
        closeDate: { before: "2026-12-15", after: null },
      },
      seen: {
        stage: { proposed: "sent the proposal", base: "Discovery" },
        amount: { proposed: 40_000, base: 30_000 },
        closeDate: { proposed: "2026-12-15", base: "2026-12-31" },
      },
    });
    const result = buildPlan(input({ proposal, review, target: RENEWAL }), column());
    expect(result.ok && result.plan).toEqual({
      v: 1,
      checks: [
        { ref: RENEWAL.ref, field: "stage", crmField: "deal.stage", seen: "Discovery" },
        { ref: RENEWAL.ref, field: "amount", crmField: "deal.amount", seen: 30_000 },
      ],
      writes: [
        {
          index: 0,
          op: "update",
          object: "deal",
          marker: M0,
          ref: RENEWAL.ref,
          properties: { stage: "s_prop", amount: 48_000 },
          associate: [],
        },
      ],
    });
  });

  it("makes a new deal named by its words, in the new deals' pipeline, at its first stage when none was said", () => {
    const proposal = proposalView(
      "deal_update",
      { amount: 25_000 },
      { new: { kind: "deal", words: "the Acme pilot" } },
      { company: ACME },
    );
    const result = buildPlan(input({ proposal, company: ACME }), column());
    expect(result.ok && result.plan.writes).toEqual([
      {
        index: 0,
        op: "create",
        object: "deal",
        marker: M0,
        ref: null,
        properties: {
          amount: 25_000,
          name: "the Acme pilot",
          pipelineId: "sales",
          stage: "s_disc",
          write_id: M0,
        },
        associate: [{ to: ACME.ref, type: "deal_company" }],
      },
    ]);
  });
});

describe("buildPlan: refusals", () => {
  it("refuses a stage the mapping can't read, quoting the rep's words", () => {
    const proposal = proposalView("deal_update", { stage: "final review" }, { linked: RENEWAL });
    expect(buildPlan(input({ proposal, target: RENEWAL }), column())).toEqual({
      ok: false,
      kind: "unmapped",
      field: "stage",
      reason: 'Testing CRM has no stage like "final review"',
    });
    // A new deal reads its stage in the new deals' pipeline only.
    const elsewhere = proposalView(
      "deal_update",
      { stage: "renewal review" },
      { new: { kind: "deal", words: "Acme" } },
    );
    expect(buildPlan(input({ proposal: elsewhere }), column())).toMatchObject({
      ok: false,
      kind: "unmapped",
      field: "stage",
    });
  });

  it("refuses what the CRM can't hold", () => {
    const noDeals = { ...CAPABILITIES, objects: { ...CAPABILITIES.objects, deal: false } };
    const deal = proposalView(
      "deal_update",
      { amount: 1 },
      { new: { kind: "deal", words: "Acme" } },
    );
    expect(buildPlan(input({ proposal: deal }), column(noDeals))).toEqual({
      ok: false,
      kind: "unsupported",
      field: null,
      reason: "Testing CRM has no deals",
    });
    const onNewDeal = proposalView("note", { body: "x" }, { new: { kind: "deal", words: "Acme" } });
    expect(buildPlan(input({ proposal: onNewDeal }), column(noDeals))).toMatchObject({
      ok: false,
      kind: "unsupported",
      field: "target",
    });
    const noLinks = { ...SCHEMA, associations: [] };
    const note = proposalView("note", { body: "x" }, { linked: ACME });
    expect(buildPlan(input({ proposal: note, target: ACME, schema: noLinks }), column())).toEqual({
      ok: false,
      kind: "unsupported",
      field: null,
      reason: "Testing CRM has no link from a note to a company",
    });
  });

  it("refuses an update with nothing to change, and values that aren't what they claim", () => {
    const nameOnly = proposalView(
      "contact",
      { name: "Dana Lee", company: "Acme" },
      { linked: DANA },
    );
    expect(buildPlan(input({ proposal: nameOnly, target: DANA }), column())).toEqual({
      ok: false,
      kind: "validation",
      field: null,
      reason: "Nothing to change on Dana Lee in Testing CRM",
    });
    const badDate = proposalView("deal_update", { closeDate: "next Friday" }, { linked: RENEWAL });
    expect(buildPlan(input({ proposal: badDate, target: RENEWAL }), column())).toMatchObject({
      ok: false,
      field: "closeDate",
    });
    const badTime = proposalView("meeting", { title: "Sync", time: "2pm" }, { linked: ACME });
    expect(buildPlan(input({ proposal: badTime, target: ACME }), column())).toMatchObject({
      ok: false,
      field: "time",
    });
    const wrongKind = proposalView("deal_update", { amount: 1 }, { linked: ACME });
    expect(buildPlan(input({ proposal: wrongKind, target: ACME }), column())).toMatchObject({
      ok: false,
      field: "target",
    });
    const noName = proposalView("note", { body: "x" }, { none: true });
    expect(buildPlan(input({ proposal: noName }), column())).toMatchObject({
      ok: false,
      kind: "validation",
      field: "target",
    });
  });

  it("doesn't quote words shaped like a key", () => {
    const proposal = proposalView(
      "deal_update",
      { stage: "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa" },
      { linked: RENEWAL },
    );
    expect(buildPlan(input({ proposal, target: RENEWAL }), column())).toMatchObject({
      ok: false,
      reason: "Testing CRM has no stage like that",
    });
  });

  it("throws when the caller made too few markers", () => {
    const proposal = proposalView(
      "note",
      { body: "x" },
      { new: { kind: "company", words: "Acme" } },
    );
    expect(() => buildPlan(input({ proposal, markers: [M0] }), column())).toThrow(TypeError);
  });

  it("is the same plan every time from the same input", () => {
    const proposal = proposalView(
      "meeting",
      { title: "Sync", date: "2026-12-03" },
      { new: { kind: "deal", words: "Acme pilot" } },
    );
    expect(buildPlan(input({ proposal }), column())).toEqual(
      buildPlan(input({ proposal }), column()),
    );
  });
});
