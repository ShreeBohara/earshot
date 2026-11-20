import type { EventEnvelope, UtteranceFinalV1 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { defaultProjections, fromJsonl, type ProposalView, replay, toJsonl } from "../src";
import { readFixture } from "./helpers";

// The Phase 2 gate (plan §10): replaying a session file rebuilds identical projections.
// The same file drives the Phase 3 replay demo.
const text = readFixture("demo-session.jsonl");

describe("demo-session.jsonl: the replay gate", () => {
  it("replays twice to deep-equal projections", () => {
    const first = replay(fromJsonl(text), defaultProjections);
    const second = replay(fromJsonl(text), defaultProjections);
    expect(second).toStrictEqual(first);
  });

  it("rebuilds the committed projection snapshot", async () => {
    const projections = replay(fromJsonl(text), defaultProjections);
    // Update deliberately with `pnpm --filter @earshot/events test -u`.
    await expect(`${JSON.stringify(projections, null, 2)}\n`).toMatchFileSnapshot(
      "../fixtures/demo-session.projections.json",
    );
  });

  it("round-trips through JSONL byte for byte", () => {
    expect(toJsonl(fromJsonl(text))).toBe(text);
  });

  // The round trip through an event store is in the store contract (src/testing.ts), so every
  // EventStore runs it: InMemoryEventStore here, and the Postgres store in @earshot/db.
});

describe("demo-session.jsonl: what the replay demo relies on", () => {
  const events = fromJsonl(text);
  const { session, utterances, proposals } = replay(events, defaultProjections);
  const byType = (type: string): ProposalView => {
    const found = proposals.find((p) => p.type === type);
    if (!found) throw new Error(`no ${type} proposal`);
    return found;
  };
  const quote = (p: ProposalView, field: string): string => {
    const evidence = p.fields[field]?.evidence;
    const source = utterances.find((u) => u.utteranceId === evidence?.utteranceId);
    if (!evidence || !source) throw new Error(`no evidence for ${p.type}.${field}`);
    return source.text.slice(evidence.span[0], evidence.span[1]);
  };

  it("is a debrief of about 40 seconds, in about 20 events, that cost under a cent", () => {
    expect(events.length).toBeGreaterThanOrEqual(18);
    expect(events.length).toBeLessThanOrEqual(22);
    expect(session).toMatchObject({ status: "ended", mode: "debrief", engine: "cascaded" });
    expect(session?.durationMs).toBeGreaterThanOrEqual(38_000);
    expect(session?.durationMs).toBeLessThanOrEqual(42_000);
    expect(session?.costUsd).toBeLessThan(0.01);
  });

  it("is about a meeting with Acme Corp", () => {
    expect(utterances[0]?.text).toContain("Acme Corp");
  });

  it("has a note, a task, a contact, a deal update, and a commitment", () => {
    expect(proposals.map((p) => p.type).sort()).toEqual([
      "commitment",
      "contact",
      "deal_update",
      "note",
      "task",
    ]);
  });

  it("proposes the task due Thursday, the contact Dana Lee, and the proposal stage", () => {
    expect(byType("task").fields.dueDate?.value).toBe("2026-11-12");
    expect(quote(byType("task"), "dueDate")).toBe("by Thursday");
    expect(byType("contact").fields.name?.value).toBe("Dana Lee");
    expect(quote(byType("contact"), "name")).toBe("Dana Lee");
    expect(quote(byType("contact"), "company")).toBe("Acme Corp");
    expect(byType("contact").targetEntityId).toBeNull();
    expect(byType("deal_update").fields.stage?.value).toBe("proposal");
    expect(quote(byType("deal_update"), "stage")).toBe("move the deal to the proposal stage");
  });

  it("upcasts every proposal to v2: the new contact, and four exact links to Acme Corp", () => {
    const stored = events.filter((e) => e.type === "proposal.created");
    expect(stored.map((e) => e.schemaVersion)).toEqual([1, 1, 1, 1, 1]);
    expect(Object.fromEntries(proposals.map((p) => [p.type, p.target.decision]))).toEqual({
      contact: "new",
      deal_update: "linked",
      task: "linked",
      note: "linked",
      commitment: "linked",
    });
    for (const p of proposals) {
      expect(p.targetEntityId, p.type).toBe(p.target.entityId);
      expect(p.target, p.type).toMatchObject({
        kind: null,
        p: null,
        mention: null,
        candidates: [],
      });
      expect(p.target.basis, p.type).toBe(p.target.decision === "linked" ? "exact" : null);
      expect(p.conflicts, p.type).toEqual([]);
    }
  });

  it("ends with one proposal rejected, one edited, and the rest approved", () => {
    expect(Object.fromEntries(proposals.map((p) => [p.type, p.status]))).toEqual({
      contact: "approved",
      deal_update: "approved",
      task: "edited",
      note: "approved",
      commitment: "rejected",
    });
    expect(byType("task").review?.editDiff).toHaveProperty("title");
  });

  it("upcasts every review to v2: its event's id, one card at a time, nothing eligible to sync", () => {
    const stored = events.filter((e) => e.type === "proposal.reviewed");
    expect(stored.map((e) => e.schemaVersion)).toEqual([1, 1, 1, 1, 1]);
    const reviews = proposals.map((p) => p.review);
    expect(reviews.map((r) => r?.reviewId).sort()).toEqual(stored.map((e) => e.id).sort());
    for (const r of reviews) {
      expect(r).toMatchObject({
        mode: "single",
        target: null,
        batchId: null,
        policy: null,
        undoes: null,
        reason: null,
        seen: null,
        input: null,
        surface: null,
        syncEligibleAt: null,
        by: null,
      });
      expect(r?.timing.decisionMs).toBe(r?.timing.handlingMs);
    }
    expect(byType("task").review?.timing.handlingMs).toBe(11_200);
  });

  it("is ended but not sealed, and has nothing snoozed or superseded", () => {
    expect(session?.sealedAt).toBeNull();
    for (const p of proposals) {
      expect(p, p.type).toMatchObject({ supersedes: null, supersededBy: null, snoozedUntil: null });
    }
  });

  it("stores one utterance at v1, which replays as the biased witness", () => {
    const v1 = events.filter((e) => e.type === "utterance.final" && e.schemaVersion === 1);
    expect(v1).toHaveLength(1);
    const id = (v1[0]?.payload as UtteranceFinalV1 | undefined)?.utteranceId;
    expect(utterances.find((u) => u.utteranceId === id)?.witness).toBe("biased");
  });

  it("points all evidence at an earlier utterance, inside its text and its audio", () => {
    for (const p of proposals) {
      for (const [field, { evidence }] of Object.entries(p.fields)) {
        const source = utterances.find((u) => u.utteranceId === evidence.utteranceId);
        const where = `${p.type}.${field}`;
        expect(source, where).toBeDefined();
        if (!source) continue;
        expect(source.seq, where).toBeLessThan(p.seq);
        const [start, end] = evidence.span;
        expect(0 <= start && start < end && end <= source.text.length, where).toBe(true);
        const [from, to] = evidence.audioMs;
        expect(source.startMs <= from && from < to && to <= source.endMs, where).toBe(true);
      }
    }
  });

  it("has ordered word timings inside each utterance", () => {
    const withWords = utterances.filter((u) => u.words !== null);
    expect(withWords.length).toBeGreaterThan(0);
    for (const u of withWords) {
      let previousEnd = u.startMs;
      for (const word of u.words ?? []) {
        expect(word.startMs).toBeGreaterThanOrEqual(previousEnd);
        expect(word.endMs).toBeGreaterThan(word.startMs);
        previousEnd = word.endMs;
      }
      expect(previousEnd).toBeLessThanOrEqual(u.endMs);
    }
  });

  it("reviews after capture ends, and keeps the session ended", () => {
    const end = events.findIndex((e: EventEnvelope) => e.type === "session.ended");
    expect(events.slice(end + 1).every((e) => e.type === "proposal.reviewed")).toBe(true);
    expect(session?.lastSeq).toBe(events.length - 1);
  });
});
