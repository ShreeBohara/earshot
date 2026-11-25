// Approval policies in SessionDO (Phase 5 spec §4.6, WP11): `start.policy` verified against the
// session's own id before it's kept, and each new proposal a rule matches approved in its turn's own
// transaction, as `proposal.reviewed` v2 with `mode: "policy"`. Real eval debriefs on their committed
// cassettes, so the proposals are what the pipeline makes: d003's first note is unmarked and linked,
// its last carries a negation note; d001's note was linked by sound (the name note); d009's deal
// updates carry an amount, then a close date; d002's contact is a new record.

import { runDurableObjectAlarm } from "cloudflare:test";
import {
  type ApprovalPolicyRules,
  type ClientMessageOf,
  DEV_SESSION_TICKET_SECRET,
  type PolicySnapshot,
  type PolicyVersion,
  type ProposalCreatedV2,
  ProposalReviewedV2,
  signPolicySnapshot,
  UNDO_WINDOW_MS,
  type UtteranceFinalV2,
  uuidv7,
} from "@earshot/core";
import { defaultProjections, replay } from "@earshot/events";
import { describe, expect, it } from "vitest";
import { evalScenario } from "../../src/e2e-scenario";
import { parseRange } from "../../src/flush-message";
import {
  breakAuditKey,
  canaryKey,
  dumpStorage,
  flushes,
  freezeClock,
  meta,
  newSession,
  open,
  reviewInput,
  reviewMessage,
  startMessage,
  type TestSocket,
  turnEndMessage,
  useCassette,
  utteranceMessage,
  withSql,
} from "./helpers";

const POLICY_ID = "01a1c6f2-7d10-7a3b-9c4d-5e6f7a8b9c0d";
const OTHER_SECRET = "another-test-ticket-secret-0123456789abcdef";

function policy(
  version: number,
  ...autoApprove: ApprovalPolicyRules["autoApprove"]
): PolicyVersion {
  return { id: POLICY_ID, version, rules: { v: 1, autoApprove } };
}

const NOTES = policy(1, { id: "notes", type: "note", alwaysReview: [] });

function scenarioOf(id: string) {
  const found = evalScenario(id);
  if (!found) throw new Error(`no eval script ${id}`);
  return found;
}

/** An utterance with word timings, as the fake speech-to-text adapter makes one. */
function timed<W extends "biased" | "unbiased">(text: string, witness: W, startMs = 2_000) {
  const words = text.split(" ").map((w, i) => ({
    w,
    startMs: startMs + i * 350,
    endMs: startMs + i * 350 + 300,
    confidence: 0.9,
  }));
  const utterance: UtteranceFinalV2 & { witness: W } = {
    utteranceId: uuidv7(),
    text,
    confidence: 0.9,
    words,
    startMs,
    endMs: words.at(-1)?.endMs ?? startMs,
    witness,
  };
  return utterance;
}

/** A started session on an eval script, its policy signed for it unless `snapshot` says otherwise. */
async function startScript(
  id: string,
  options: {
    policy?: PolicyVersion | null;
    snapshot?: (sid: string) => Promise<PolicySnapshot>;
  } = {},
) {
  const script = scenarioOf(id);
  const opened = await open();
  await useCassette(opened.stub, id);
  const chosen = options.policy === undefined ? NOTES : options.policy;
  const snapshot = options.snapshot
    ? await options.snapshot(opened.ids.sid)
    : chosen
      ? await signPolicySnapshot(DEV_SESSION_TICKET_SECRET, chosen, opened.ids.sid)
      : undefined;
  const start = startMessage({
    startedAt: script.startedAt,
    timeZone: script.timeZone,
    entities: script.entities.map((entity) => ({ ...entity, aliases: [...entity.aliases] })),
    ...(script.focusEntityId ? { focusEntityId: script.focusEntityId } : {}),
    ...(snapshot ? { policy: snapshot } : {}),
  });
  return { ...opened, script, start };
}

/** Says one turn, and resolves with the events its `turn_end` appended, in order. */
async function sayTurn(socket: TestSocket, text: string, startMs = 2_000) {
  const turnId = uuidv7();
  await socket.request(utteranceMessage(turnId, timed(text, "biased", startMs)));
  const before = socket.events().length;
  const ack = await socket.request(turnEndMessage(turnId, canaryKey()), 15_000);
  // The ack comes after the events it appended, which arrive as they're broadcast.
  await socket.waitFor(() => (socket.events().at(-1)?.seq ?? -1) >= (ack.seq ?? 0));
  return { turnId, ack, events: socket.events().slice(before) };
}

const created = (socket: TestSocket) =>
  socket.eventsOf("proposal.created").map((event) => event.payload as unknown as ProposalCreatedV2);
const reviews = (socket: TestSocket) =>
  socket.eventsOf("proposal.reviewed").map((event) => ProposalReviewedV2.parse(event.payload));

describe("start.policy", () => {
  it("keeps a snapshot signed for this session, without its signature", async () => {
    const { socket, stub, start } = await startScript("d003");
    await socket.request(start);
    expect(socket.eventsOf("session.started")).toHaveLength(1);
    expect(JSON.parse((await meta(stub)).policy ?? "null")).toEqual(NOTES);
    const sig = start.policy?.sig ?? "";
    expect(sig).toHaveLength(43);
    expect(await dumpStorage(stub)).not.toContain(sig);
    socket.close();
  });

  it("refuses a forged snapshot, one replayed from another session, or one signed with another secret, with bad_message", async () => {
    const forgeries: [string, (sid: string) => Promise<PolicySnapshot>][] = [
      [
        "a rule added after signing",
        async (sid) => {
          const signed = await signPolicySnapshot(DEV_SESSION_TICKET_SECRET, NOTES, sid);
          return {
            ...signed,
            rules: {
              v: 1,
              autoApprove: [
                ...NOTES.rules.autoApprove,
                { id: "tasks", type: "task", alwaysReview: [] },
              ],
            },
          };
        },
      ],
      [
        "an older version's signature on a newer number",
        async (sid) => ({
          ...(await signPolicySnapshot(DEV_SESSION_TICKET_SECRET, NOTES, sid)),
          version: 2,
        }),
      ],
      [
        "a snapshot signed for another session",
        async () => signPolicySnapshot(DEV_SESSION_TICKET_SECRET, NOTES, newSession().sid),
      ],
      [
        "a snapshot signed with another secret",
        async (sid) => signPolicySnapshot(OTHER_SECRET, NOTES, sid),
      ],
    ];
    for (const [label, snapshot] of forgeries) {
      const { socket, stub, start } = await startScript("d003", { snapshot });
      socket.send(start);
      expect(await socket.error(start.msgId), label).toMatchObject({
        code: "bad_message",
        retryable: false,
      });
      expect(socket.eventsOf("session.started"), label).toEqual([]);
      expect((await meta(stub)).policy, label).toBeUndefined();
      // Refused, not remembered: the same session starts once a valid snapshot comes.
      const valid = await signPolicySnapshot(
        DEV_SESSION_TICKET_SECRET,
        NOTES,
        (await meta(stub)).sid ?? "",
      );
      const restart: ClientMessageOf<"start"> = { ...start, msgId: uuidv7(), policy: valid };
      await socket.request(restart);
      expect(socket.eventsOf("session.started"), label).toHaveLength(1);
      socket.close();
    }
  });

  it("keeps the policy the session started with: a later start's snapshot changes nothing", {
    timeout: 30_000,
  }, async () => {
    const { socket, stub, start, ids, script } = await startScript("d003");
    const first = await socket.request(start);
    // The workspace's policy changes mid-session: a new version, validly signed for this session.
    const changed = await signPolicySnapshot(DEV_SESSION_TICKET_SECRET, policy(2), ids.sid);
    const later: ClientMessageOf<"start"> = { ...start, msgId: uuidv7(), policy: changed };
    const again = await socket.request(later);
    expect(again.seq).toBe(first.seq);
    expect(JSON.parse((await meta(stub)).policy ?? "null")).toEqual(NOTES);
    // This session still approves under version 1; the change applies from the next session.
    await sayTurn(socket, script.turns[0]?.text ?? "");
    expect(reviews(socket)).toMatchObject([
      { mode: "policy", policy: { id: POLICY_ID, version: 1 } },
    ]);
    socket.close();
  });
});

describe("auto-approval at creation", () => {
  it("approves an unmarked, linked note in the turn's own transaction, as the policy's v2 review", {
    timeout: 30_000,
  }, async () => {
    const { socket, stub, start, ids, script } = await startScript("d003");
    await socket.request(start);
    const now = Date.now();
    await freezeClock(stub, now);
    const turn = await sayTurn(socket, script.turns[0]?.text ?? "");
    // The approval follows its proposal, before the turn's usage and its end, in one commit.
    expect(turn.events.map((event) => event.type)).toEqual([
      "proposal.created",
      "proposal.reviewed",
      "usage.recorded",
      "turn.completed",
    ]);
    expect(turn.ack.seq).toBe(turn.events.at(-1)?.seq);
    const [note] = created(socket);
    expect(note).toMatchObject({ type: "note", target: { decision: "linked" } });
    const [approval] = reviews(socket);
    expect(approval).toEqual({
      reviewId: expect.any(String),
      proposalId: note?.proposalId,
      decision: "approved",
      target: null,
      mode: "policy",
      batchId: null,
      policy: { id: POLICY_ID, version: 1, rule: "notes" },
      undoes: null,
      reason: null,
      seen: {
        tier: "none",
        fields: { body: { proposed: note?.fields.body?.value } },
        target: {
          entityId: note?.target.entityId,
          offered: note?.target.candidates.map((candidate) => candidate.entityId),
        },
        relinked: null,
        clip: "none",
      },
      timing: { decisionMs: 0, handlingMs: 0 },
      input: "none",
      surface: "session",
      syncEligibleAt: new Date(now + UNDO_WINDOW_MS).toISOString(),
      by: { userId: ids.uid, auth: null },
    });
    // Its id is recorded, so no client can reuse it.
    const recorded = await withSql(stub, (sql) =>
      sql
        .exec("SELECT kind, proposal_id FROM writes WHERE id = ?", approval?.reviewId ?? "")
        .toArray(),
    );
    expect(recorded).toEqual([{ kind: "review", proposal_id: note?.proposalId }]);
    // The log folds to an approved proposal, and the flush carries the review to Postgres, where
    // the consumer gives it its audit row.
    const log = parseRange(await stub.readRange(0, 99)).map((event) => ({
      ...event,
      sessionId: ids.sid,
    }));
    const { proposals } = replay(log, defaultProjections);
    expect(proposals[0]).toMatchObject({ status: "approved", review: { mode: "policy" } });
    await freezeClock(stub, null);
    socket.close();
  });

  it("approves nothing without a snapshot, as before policies", { timeout: 30_000 }, async () => {
    const { socket, start, script } = await startScript("d003", { policy: null });
    expect(start.policy).toBeUndefined();
    await socket.request(start);
    await sayTurn(socket, script.turns[0]?.text ?? "");
    expect(created(socket)).toHaveLength(1);
    expect(reviews(socket)).toEqual([]);
    socket.close();
  });

  it("never approves a marked note (a negation), or the name note (linked by sound)", {
    timeout: 60_000,
  }, async () => {
    // d003: turn 1's note is unmarked; turn 4's says its words in a negation, a quiet note.
    const d003 = await startScript("d003");
    await d003.socket.request(d003.start);
    for (const [index, turn] of d003.script.turns.entries()) {
      await sayTurn(d003.socket, turn.text, 2_000 + index * 20_000);
    }
    const notes = created(d003.socket).filter((proposal) => proposal.type === "note");
    expect(notes).toHaveLength(2);
    expect(notes[1]?.riskFlags).toEqual([{ kind: "negation", field: "body" }]);
    expect(reviews(d003.socket).map((review) => review.proposalId)).toEqual([notes[0]?.proposalId]);
    d003.socket.close();

    // d001: turn 1's note links by sound, below certainty: the name note.
    const d001 = await startScript("d001");
    await d001.socket.request(d001.start);
    await sayTurn(d001.socket, d001.script.turns[0]?.text ?? "");
    expect(created(d001.socket)).toMatchObject([
      { type: "note", target: { decision: "linked" }, riskFlags: [{ kind: "link_uncertain" }] },
    ]);
    expect(reviews(d001.socket)).toEqual([]);
    d001.socket.close();
  });

  it("holds back a deal update carrying an alwaysReview field, and approves the one without it", {
    timeout: 60_000,
  }, async () => {
    const deals = policy(1, {
      id: "deal-updates",
      type: "deal_update",
      alwaysReview: ["amount", "stage"],
    });
    const { socket, start, script } = await startScript("d009", { policy: deals });
    await socket.request(start);
    await sayTurn(socket, script.turns[0]?.text ?? "");
    await sayTurn(socket, script.turns[1]?.text ?? "", 22_000);
    const [amount, closeDate] = created(socket);
    expect(Object.keys(amount?.fields ?? {})).toEqual(["amount"]);
    expect(Object.keys(closeDate?.fields ?? {})).toEqual(["closeDate"]);
    expect(reviews(socket)).toMatchObject([
      { proposalId: closeDate?.proposalId, policy: { rule: "deal-updates" } },
    ]);
    socket.close();
  });

  it("never approves a new-record target", { timeout: 60_000 }, async () => {
    const contacts = policy(1, { id: "contacts", type: "contact", alwaysReview: [] });
    const { socket, start, script } = await startScript("d002", { policy: contacts });
    await socket.request(start);
    for (const [index, turn] of script.turns.slice(0, 3).entries()) {
      await sayTurn(socket, turn.text, 2_000 + index * 20_000);
    }
    expect(created(socket).filter((proposal) => proposal.type === "contact")).toMatchObject([
      { target: { decision: "new" } },
    ]);
    expect(reviews(socket)).toEqual([]);
    socket.close();
  });

  it("applies no policy without a usable audit key: the flush couldn't record its approvals", {
    timeout: 30_000,
  }, async () => {
    const { socket, stub, start, script } = await startScript("d003");
    await socket.request(start);
    await breakAuditKey(stub, true);
    await sayTurn(socket, script.turns[0]?.text ?? "");
    expect(created(socket)).toHaveLength(1);
    expect(reviews(socket)).toEqual([]);
    await breakAuditKey(stub, false);
    socket.close();
  });

  it("can be undone over the socket like any other approval", { timeout: 30_000 }, async () => {
    const { socket, stub, start, ids, script } = await startScript("d003");
    await socket.request(start);
    await sayTurn(socket, script.turns[0]?.text ?? "");
    const [approval] = reviews(socket);
    if (!approval) throw new Error("no auto-approval");
    // A review sent under the policy's review id is taken for a resend of it: it gets that
    // review's seq, and nothing is written.
    const approvalSeq = socket.eventsOf("proposal.reviewed")[0]?.seq;
    const reused = await socket.request(
      reviewMessage(
        reviewInput(approval.proposalId, {
          reviewId: approval.reviewId,
          decision: "reopened",
          undoes: approval.reviewId,
          reason: "undo",
        }),
      ),
    );
    expect(reused.seq).toBe(approvalSeq);
    expect(reviews(socket)).toHaveLength(1);
    const undo = reviewMessage(
      reviewInput(approval.proposalId, {
        decision: "reopened",
        undoes: approval.reviewId,
        reason: "undo",
      }),
    );
    await socket.request(undo);
    expect(reviews(socket).map((review) => [review.decision, review.mode])).toEqual([
      ["approved", "policy"],
      ["reopened", "single"],
    ]);
    const log = parseRange(await stub.readRange(0, 99)).map((event) => ({
      ...event,
      sessionId: ids.sid,
    }));
    expect(replay(log, defaultProjections).proposals[0]?.status).toBe("proposed");
    socket.close();
  });
});

// ─── Decision 15: a later conflict reopens an auto-approval ──────────────────────────────────────

describe("a flag after an auto-approval", () => {
  it("reopens it, naming the policy's review: flagged, a system reopen, then turn.witnessed", {
    timeout: 30_000,
  }, async () => {
    const { socket, stub, start, ids, script } = await startScript("d003");
    await socket.request(start);
    const said = script.turns[0]?.text ?? "";
    const turn = await sayTurn(socket, said);
    const [approval] = reviews(socket);
    expect(approval).toMatchObject({ mode: "policy", decision: "approved" });

    // The second witness heard the account's name otherwise.
    const witness: ClientMessageOf<"witness"> = {
      t: "witness",
      msgId: uuidv7(),
      turnId: turn.turnId,
      provider: "groq",
      model: "whisper-large-v3-turbo",
      outcome: "transcribed",
      utterance: timed(said.replace("Atmos Industrial", "Atmo Systems"), "unbiased"),
      latencyMs: 812,
    };
    await socket.request(witness);
    const events = socket.events();
    const witnessed = events.findIndex(
      (event) => event.type === "utterance.final" && event.payload.witness === "unbiased",
    );
    expect(events.slice(witnessed).map((event) => event.type)).toEqual([
      "utterance.final",
      "proposal.flagged",
      "proposal.reviewed",
      "turn.witnessed",
    ]);
    expect(ProposalReviewedV2.parse(events[witnessed + 2]?.payload)).toMatchObject({
      decision: "reopened",
      mode: "system",
      reason: "flagged",
      undoes: approval?.reviewId,
      policy: null,
      by: { userId: ids.uid, auth: null },
    });
    const log = parseRange(await stub.readRange(0, 99)).map((event) => ({
      ...event,
      sessionId: ids.sid,
    }));
    expect(replay(log, defaultProjections).proposals[0]).toMatchObject({
      status: "proposed",
      review: { mode: "system", undoes: approval?.reviewId },
    });
    // Both the approval and its reopen reach the flush, each for its own audit row.
    await runDurableObjectAlarm(stub);
    const flushed = (await flushes(stub)).flatMap((message) => message.events ?? []);
    expect(flushed.filter((event) => event.type === "proposal.reviewed")).toHaveLength(2);
    socket.close();
  });
});
