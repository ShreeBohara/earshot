// Corrections and follow-up skips in Postgres (Phase 5 WP13): the web Worker's writes after the seal,
// under the session's lock, on PGlite with every migration and row-level security.
import { correctionProposalId } from "@earshot/core";
import { type EventDraft, NO_EVENTS } from "@earshot/events";
import {
  draft,
  ended,
  followupAsked,
  proposalV2,
  reviewV2,
  sealed,
  started,
  utterance,
  uuid,
} from "@earshot/events/testing";
import { correctProposal } from "@earshot/understanding/correct";
import { buildLinkIndex } from "@earshot/understanding/link";
import type { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type CorrectionReadInput,
  correctionUtterances,
  lastAudioMs,
  type SessionCorrectionRequest,
  writeFollowupSkip,
  writeSessionCorrection,
} from "../src/corrections";
import { appendEvents, readEvents } from "../src/event-store";
import { rebuildProjections } from "../src/projections";
import { proposals, utterances } from "../src/schema";
import { withTenant } from "../src/tenant";
import { A, B, cloneDb, migratedDb } from "./db";
import { createTenant } from "./tenants";

type Db = Awaited<ReturnType<typeof migratedDb>>["db"];

const S1 = uuid(0x5c01);
const SB = uuid(0x5cb0);
const NOW = new Date("2026-11-20T12:00:00.000Z");

let template: PGlite;
const opened: PGlite[] = [];

beforeAll(async () => {
  const { client, db } = await migratedDb();
  await createTenant(db, A, [S1]);
  await createTenant(db, B, [SB]);
  template = client;
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((client) => client.close()));
});

afterAll(async () => {
  await template.close();
});

async function fresh(): Promise<Db> {
  const copy = await cloneDb(template);
  opened.push(copy.client);
  return copy.db;
}

let ids = 0xc000;
const newId = () => {
  ids += 1;
  return uuid(ids);
};

/**
 * A debrief: a task for "Akme" (uuid 6001) with no due date, which a question asks for, and a
 * second task; ended, and sealed unless `seal` is false.
 */
function debrief(seal = true): EventDraft[] {
  return [
    draft(1, started()),
    draft(2, utterance(1, "Akme wants the deck.")),
    draft(3, proposalV2(1)),
    draft(4, proposalV2(2, {}, { riskFlags: [] })),
    draft(5, followupAsked(1, 1)),
    draft(6, ended()),
    ...(seal ? [draft(7, sealed())] : []),
  ];
}

/** The same events with ids no other session's share: utterance and proposal ids are global. */
function distinct(events: EventDraft[]): EventDraft[] {
  return JSON.parse(
    JSON.stringify(events).replaceAll("00000000-0000-7000-8000-", "0000000b-0000-7000-8000-"),
  );
}

async function seed(db: Db, sessionId: string, events: EventDraft[], tenant = A) {
  await withTenant(db, tenant, async (tx) => {
    await appendEvents(tx, sessionId, NO_EVENTS, events);
    await rebuildProjections(tx, sessionId);
  });
}

const INDEX = buildLinkIndex([
  { id: uuid(6001), kind: "company", name: "Acme Dynamics", aliases: [] },
  { id: uuid(6002), kind: "company", name: "Atlas Freight", aliases: [] },
]);

/** The route's reader: `correctProposal` over a small mirror, at the session's start, in Chicago. */
async function read(input: CorrectionReadInput) {
  return correctProposal(input.original, input.field, input.utterances, {
    index: INDEX,
    focusEntityId: null,
    recent: [],
    kinds: ["company", "contact", "deal"],
    callTime: input.session.startedAt,
    timeZone: "America/Chicago",
  });
}

function correct(db: Db, request: Partial<SessionCorrectionRequest>, sessionId = S1, tenant = A) {
  return withTenant(db, tenant, (tx) =>
    writeSessionCorrection(
      tx,
      sessionId,
      {
        correctionId: uuid(0xcc01),
        proposalId: uuid(3001),
        field: "dueDate",
        questionId: null,
        words: { input: "typed", text: "Friday" },
        ...request,
      },
      { now: NOW, newId, proposalIdFor: correctionProposalId, read },
    ),
  );
}

async function logOf(db: Db, sessionId = S1) {
  return withTenant(db, A, (tx) => readEvents(tx, sessionId));
}

describe("placing a correction's words on the session's clock", () => {
  it("puts typed words at the session's last audio time, with confidence 1 and no words", () => {
    expect(lastAudioMs([{ endMs: 1800 }, { endMs: 4200 }, { endMs: 3000 }])).toBe(4200);
    expect(lastAudioMs([])).toBe(0);
    expect(correctionUtterances({ input: "typed", text: "the 14th" }, 4200, () => "u1")).toEqual([
      {
        utteranceId: "u1",
        text: "the 14th",
        confidence: 1,
        startMs: 4200,
        endMs: 4200,
        witness: "biased",
        input: "typed",
      },
    ]);
  });

  it("moves a dictation's segments and words from its own start to the session's last audio time", () => {
    const placed = correctionUtterances(
      {
        input: "speech",
        utterances: [
          {
            text: "Friday.",
            confidence: 0.9,
            startMs: 100,
            endMs: 700,
            words: [{ w: "Friday.", startMs: 150, endMs: 650, confidence: 0.9 }],
          },
        ],
      },
      4200,
      () => "u2",
    );
    expect(placed).toEqual([
      {
        utteranceId: "u2",
        text: "Friday.",
        confidence: 0.9,
        words: [{ w: "Friday.", startMs: 4350, endMs: 4850, confidence: 0.9 }],
        startMs: 4300,
        endMs: 4900,
        witness: "biased",
        input: "speech",
      },
    ]);
  });
});

describe("writeSessionCorrection", () => {
  it("refuses until the session is sealed, writing nothing", async () => {
    const db = await fresh();
    await seed(db, S1, debrief(false));
    expect(await correct(db, {})).toEqual({ ok: false, reason: "not_sealed" });
    expect(await logOf(db)).toHaveLength(6);
  });

  it("appends the typed words, a proposal superseding the one corrected, and the question it answers", async () => {
    const db = await fresh();
    await seed(db, S1, debrief());
    const proposalId = await correctionProposalId(S1, uuid(0xcc01));
    const outcome = await correct(db, { questionId: uuid(9001) });
    expect(outcome).toEqual({
      ok: true,
      recorded: "now",
      proposalId,
      seq: 8,
      answered: [uuid(9001)],
      lastSeq: 9,
    });
    const log = await logOf(db);
    expect(log.slice(7).map((event) => [event.type, event.schemaVersion])).toEqual([
      ["utterance.final", 3],
      ["proposal.created", 2],
      ["followup.closed", 1],
    ]);
    expect(log[7]?.payload).toMatchObject({ text: "Friday", input: "typed", confidence: 1 });
    expect(log[8]?.payload).toMatchObject({
      proposalId,
      supersedes: uuid(3001),
      linker: "linker.v1",
      fields: { dueDate: { value: "2026-11-13" } },
    });
    expect(log[9]?.payload).toEqual({ questionId: uuid(9001), outcome: "answered", proposalId });

    const rows = await withTenant(db, A, (tx) =>
      tx.select().from(proposals).where(eq(proposals.sessionId, S1)).orderBy(asc(proposals.seq)),
    );
    expect(rows.map((row) => [row.id, row.status, row.supersededBy])).toEqual([
      [uuid(3001), "superseded", proposalId],
      [uuid(3002), "proposed", null],
      [proposalId, "proposed", null],
    ]);
    expect(rows[2]?.followups).toEqual([
      expect.objectContaining({
        questionId: uuid(9001),
        status: "answered",
        answeredBy: proposalId,
      }),
    ]);
    const typed = await withTenant(db, A, (tx) =>
      tx.select().from(utterances).where(eq(utterances.input, "typed")),
    );
    expect(typed.map((row) => [row.text, row.startedMs, row.endedMs])).toEqual([
      ["Friday", 1800, 1800],
    ]);
  });

  it("answers a resend with the first one's proposal, appending nothing", async () => {
    const db = await fresh();
    await seed(db, S1, debrief());
    const first = await correct(db, {});
    const again = await correct(db, { words: { input: "typed", text: "Monday" } });
    expect(again).toEqual({ ...first, recorded: "before" });
    expect(await logOf(db)).toHaveLength(10);
  });

  it("appends nothing for words with no value of the field's kind, and says what it couldn't read", async () => {
    const db = await fresh();
    await seed(db, S1, debrief());
    expect(await correct(db, { words: { input: "typed", text: "whenever suits them" } })).toEqual({
      ok: false,
      reason: "unreadable",
      unreadable: { ok: false, reason: "unreadable", kind: "date", words: "whenever suits them" },
    });
    expect(await logOf(db)).toHaveLength(7);
  });

  it("refuses a replaced proposal, a decided one, and a question asking for another field", async () => {
    const db = await fresh();
    await seed(db, S1, [
      ...debrief().slice(0, 6),
      draft(20, reviewV2(2, "approved")),
      draft(7, sealed()),
    ]);
    expect(await correct(db, { proposalId: uuid(3002), correctionId: uuid(0xcc02) })).toMatchObject(
      { ok: false, reason: "refused", refusal: "not_proposed" },
    );
    expect(
      await correct(db, { field: "title", questionId: uuid(9001), correctionId: uuid(0xcc03) }),
    ).toMatchObject({ ok: false, reason: "refused", refusal: "malformed" });
    await correct(db, {});
    expect(
      await correct(db, {
        field: "title",
        correctionId: uuid(0xcc04),
        words: { input: "typed", text: "x" },
      }),
    ).toMatchObject({ ok: false, reason: "refused", refusal: "superseded" });
  });

  it("refuses a correction past the session's limits, with a fixed reason, writing nothing", async () => {
    const db = await fresh();
    await seed(db, S1, debrief());
    // Typed words past the session's budget.
    const long = "Friday ".repeat(3_000).slice(0, 20_001);
    expect(
      await correct(db, { correctionId: uuid(0xcc10), words: { input: "typed", text: long } }),
    ).toMatchObject({ ok: false, reason: "refused", refusal: "too_many" });
    // A card corrected five times over takes no sixth.
    let proposalId = uuid(3001);
    for (let n = 0; n < 5; n += 1) {
      const outcome = await correct(db, {
        correctionId: uuid(0xcd00 + n),
        proposalId,
        field: "title",
        words: { input: "typed", text: `Send the deck v${n}` },
      });
      if (!outcome.ok) throw new Error(`correction ${n} refused`);
      proposalId = outcome.proposalId;
    }
    const before = (await logOf(db)).length;
    expect(
      await correct(db, {
        correctionId: uuid(0xcd10),
        proposalId,
        field: "title",
        words: { input: "typed", text: "Send the deck v5" },
      }),
    ).toMatchObject({ ok: false, reason: "refused", refusal: "too_deep" });
    expect(await logOf(db)).toHaveLength(before);
  });

  it("can't reach another workspace's session", async () => {
    const db = await fresh();
    await seed(db, SB, distinct(debrief()), B);
    expect(await correct(db, {}, SB, A)).toEqual({ ok: false, reason: "not_found" });
    expect(await correct(db, {}, uuid(0x5cff), A)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("writeFollowupSkip", () => {
  const skip = (db: Db, questionId = uuid(9001), sessionId = S1, tenant = A) =>
    withTenant(db, tenant, (tx) =>
      writeFollowupSkip(tx, sessionId, questionId, { now: NOW, newId }),
    );

  it("closes an open question after the seal, and answers a resend", async () => {
    const db = await fresh();
    await seed(db, S1, debrief(false));
    expect(await skip(db)).toEqual({ ok: false, reason: "not_sealed" });
    await withTenant(db, A, async (tx) => {
      await appendEvents(tx, S1, 5, [draft(7, sealed())]);
      await rebuildProjections(tx, S1);
    });
    expect(await skip(db)).toEqual({ ok: true, recorded: "now", lastSeq: 7 });
    expect(await skip(db)).toEqual({ ok: true, recorded: "before", lastSeq: 7 });
    const [first] = await withTenant(db, A, (tx) =>
      tx
        .select()
        .from(proposals)
        .where(eq(proposals.id, uuid(3001))),
    );
    expect(first?.followups).toEqual([expect.objectContaining({ status: "skipped" })]);
  });

  it("refuses an unknown question, one a correction answered, and another workspace's", async () => {
    const db = await fresh();
    await seed(db, S1, debrief());
    await seed(db, SB, distinct(debrief()), B);
    expect(await skip(db, uuid(9009))).toMatchObject({ ok: false, refusal: "unknown_question" });
    await correct(db, { questionId: uuid(9001) });
    expect(await skip(db)).toMatchObject({ ok: false, refusal: "question_closed" });
    expect(await skip(db, uuid(9001), SB, A)).toEqual({ ok: false, reason: "not_found" });
  });
});
