import type { EventEnvelope, UtteranceFinalV1 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import {
  defaultProjections,
  fromJsonl,
  InMemoryEventStore,
  NO_EVENTS,
  type ProposalView,
  replay,
  toJsonl,
} from "../src";
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

  it("round-trips through the event store byte for byte", async () => {
    const events = fromJsonl(text);
    const sessionId = events[0]?.sessionId ?? "";
    const store = new InMemoryEventStore();
    // Pre-numbered drafts, as SessionDO will flush them: the store checks every seq.
    await store.append(
      sessionId,
      NO_EVENTS,
      events.map(({ sessionId: _, ...draft }) => draft),
    );
    expect(toJsonl(await store.read(sessionId))).toBe(text);
  });
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
