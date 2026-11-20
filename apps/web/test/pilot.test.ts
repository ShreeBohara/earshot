// The pilot page's libraries (Phase 5 spec WP7 step 2; ADR-0039): pilot.v1 as the page shows it,
// built from the committed set and the demo CRM; the local sink, which folds writes in the page
// after the writers' own rules; the progress kept in sessionStorage; the results file, with §4.8's
// fields and nothing else, as `pilot:analyze` reads it; the consent text, word for word; and ?p=.
import { readFileSync } from "node:fs";
import { companies, contacts, deals } from "@earshot/demo-crm";
import { analyzePilot, PilotManifest, PilotResults } from "@earshot/evals/pilot";
import { tierOf } from "@earshot/understanding/tiers";
import { describe, expect, it, vi } from "vitest";
import { batchPlan, batchReviews } from "@/lib/inbox/batch";
import { cardModel } from "@/lib/inbox/card";
import { decisionReview, snoozeOf, undoReview } from "@/lib/inbox/review";
import { consentBlocks, consentWords } from "@/lib/pilot/consent";
import { buildPilotData, type PilotManifestLike } from "@/lib/pilot/data";
import { participantOf } from "@/lib/pilot/participant";
import {
  LocalReviewLog,
  type PilotProgress,
  progressKey,
  readProgress,
  writeProgress,
} from "@/lib/pilot/progress";
import { browserOf, resultsFile, resultsFileName, resultsText } from "@/lib/pilot/results";
import { findInRepo } from "@/lib/repo-path";

const SET = "packages/evals/pilot/pilot.v1";
const read = (name: string) => readFileSync(findInRepo(`${SET}/${name}`), "utf8");
const manifest = PilotManifest.parse(JSON.parse(read("manifest.json")));
const logs = Object.fromEntries(
  [...manifest.sessions, manifest.practice].map((entry) => [entry.file, read(entry.file)]),
);
// The page's view of the manifest is the evals' shape, narrowed.
const pageManifest: PilotManifestLike = manifest;
const data = buildPilotData({
  manifest: pageManifest,
  logs,
  crm: { companies, contacts, deals },
});
const TIMING = { decisionMs: 1_200, handlingMs: 1_500 };
const NOW = new Date("2026-12-01T10:00:00.000Z");

describe("pilot.v1 as the page shows it", () => {
  it("holds the 10 sessions and the practice, sealed, with the manifest's proposals", () => {
    expect(data.sessions.map((session) => session.id)).toEqual(
      manifest.sessions.map((session) => session.id),
    );
    expect(data.setSha256).toBe(manifest.sha256);
    for (const [index, pilot] of data.sessions.entries()) {
      const entry = manifest.sessions[index];
      expect(pilot.session.sessionId).toBe(entry?.sessionId);
      expect(pilot.session.sealedAt).not.toBeNull();
      expect(pilot.session.proposals.map((p) => p.proposalId)).toEqual(entry?.proposals);
      expect(pilot.session.proposals.every((p) => p.status === "proposed")).toBe(true);
      expect(pilot.session.focusEntityId).toBe(entry?.focusEntityId);
    }
    expect(data.practice.session.proposals).toHaveLength(3);
    expect(data.orders).toEqual(manifest.orders);
  });

  it("names every record a card points at, with its account, and quotes every field's words", () => {
    const all = [...data.sessions, data.practice].flatMap((pilot) => pilot.session.proposals);
    for (const proposal of all) {
      const { target } = proposal;
      for (const candidate of target.candidates) {
        if (candidate.entityId) expect(data.entities[candidate.entityId]).toBeDefined();
      }
      for (const field of Object.values(proposal.fields)) {
        expect(data.quotes[field.evidence.utteranceId]).toBeDefined();
      }
      const model = cardModel(proposal, data.entities, data.quotes);
      expect(model.record).not.toContain("a CRM record");
      for (const row of model.fields) expect(row.heard).not.toBeNull();
    }
    for (const entity of Object.values(data.entities)) {
      if (entity.accountId) expect(data.entities[entity.accountId]?.kind).toBe("company");
    }
  });

  it("says when each call was, in the rep's own time zone", () => {
    const first = manifest.sessions[0];
    const expected = new Intl.DateTimeFormat("en-US", {
      timeZone: first?.timeZone,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(first?.callTime ?? ""));
    expect(data.sessions[0]?.when).toBe(expected);
  });

  it("shows each seeded error as the manifest says: loud questions, and links with the name note alone", () => {
    const byId = new Map(
      data.sessions.flatMap((pilot) => pilot.session.proposals).map((p) => [p.proposalId, p]),
    );
    for (const error of manifest.seeded) {
      const proposal = byId.get(error.proposalId);
      expect(proposal).toBeDefined();
      if (!proposal) continue;
      const model = cardModel(proposal, data.entities, data.quotes);
      if (error.kind === "flagged") {
        expect(model.tier.tier).toBe("loud");
        expect(model.firstPerson).not.toBeNull();
        // "New" is one of the numbered choices.
        expect(model.chooser?.options.some((o) => o.kind === "record" && o.entityId === null)).toBe(
          true,
        );
      } else {
        expect(model.tier).toEqual({ tier: "quiet", reasons: [], nameNote: "sound" });
        expect(model.nameNote).toBe("matched by sound");
        expect(model.firstPerson).toBeNull();
        // The correction panel offers the right record second.
        const second = model.correction[1];
        expect(second?.kind === "record" ? second.entityId : undefined).toBe(error.right.entityId);
      }
    }
  });

  it("refuses a log that doesn't match its manifest", () => {
    expect(() =>
      buildPilotData({
        manifest: pageManifest,
        logs: { ...logs, "s01.jsonl": logs["s02.jsonl"] as string },
        crm: { companies, contacts, deals },
      }),
    ).toThrow(/isn't session/);
  });
});

describe("the local sink", () => {
  const session = data.sessions[0]?.session;
  if (!session) throw new Error("no s01");
  const linked = session.proposals.find(
    (p) => p.target.decision === "linked" && tierOf(p).tier !== "loud",
  );
  if (!linked) throw new Error("s01 has no linked card");
  const ask = data.sessions
    .flatMap((pilot) => pilot.session.proposals)
    .find((p) => p.target.decision === "ask");
  const newLog = (onChange?: (events: readonly unknown[]) => void) =>
    new LocalReviewLog([session], [], {
      participant: "P1",
      now: () => NOW,
      ...(onChange ? { onChange } : {}),
    });

  it("writes a review as the route would: who, no sign-in, and the 30 s sync window", async () => {
    const onChange = vi.fn();
    const log = newLog(onChange);
    const review = decisionReview({
      proposal: linked,
      entities: data.entities,
      decision: "approved",
      timing: TIMING,
      input: "keyboard",
      surface: "pilot",
    });
    expect(await log.sink().send(session.sessionId, { reviews: [review], snoozes: [] })).toEqual({
      ok: true,
    });
    const [written] = log.reviews();
    expect(written).toMatchObject({
      reviewId: review.reviewId,
      surface: "pilot",
      by: { userId: "P1", auth: null },
      syncEligibleAt: "2026-12-01T10:00:30.000Z",
    });
    expect(
      log.sessions()[0]?.proposals.find((p) => p.proposalId === linked.proposalId),
    ).toMatchObject({ status: "approved", review: { reviewId: review.reviewId } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("refuses what the writers' rules refuse, all or nothing", async () => {
    const log = newLog();
    const review = decisionReview({
      proposal: linked,
      entities: data.entities,
      decision: "approved",
      timing: TIMING,
      input: "keyboard",
      surface: "pilot",
    });
    const sink = log.sink();
    expect((await sink.send(session.sessionId, { reviews: [review], snoozes: [] })).ok).toBe(true);
    // Deciding it again is stale; another session's id is gone.
    const again = { ...review, reviewId: "00000000-0000-7000-8000-00000000abcd" };
    expect(await sink.send(session.sessionId, { reviews: [again], snoozes: [] })).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(
      await sink.send("00000000-0000-7000-8000-000000000000", { reviews: [], snoozes: [] }),
    ).toEqual({ ok: false, reason: "gone" });
    expect(log.reviews()).toHaveLength(1);
  });

  it("refuses a question approved without a record, and a batch that takes a marked card", async () => {
    if (!ask) throw new Error("the set has no question");
    const owner = data.sessions.find((pilot) =>
      pilot.session.proposals.some((p) => p.proposalId === ask.proposalId),
    )?.session;
    if (!owner) throw new Error("no session for the question");
    const log = new LocalReviewLog([owner], [], { participant: "P1", now: () => NOW });
    const noRecord = decisionReview({
      proposal: ask,
      entities: data.entities,
      decision: "approved",
      timing: TIMING,
      input: "keyboard",
      surface: "pilot",
    });
    expect(await log.sink().send(owner.sessionId, { reviews: [noRecord], snoozes: [] })).toEqual({
      ok: false,
      reason: "invalid",
    });
    const marked = batchReviews([ask], {
      entities: data.entities,
      timing: TIMING,
      input: "keyboard",
      surface: "pilot",
    });
    expect(
      await log.sink().send(owner.sessionId, { reviews: marked.reviews, snoozes: [] }),
    ).toEqual({ ok: false, reason: "invalid" });
    // What the page's own "accept all" builds is accepted.
    const plan = batchPlan(owner.sessionId, owner.proposals);
    if (plan.accept.length > 0) {
      const { reviews } = batchReviews(plan.accept, {
        entities: data.entities,
        timing: TIMING,
        input: "keyboard",
        surface: "pilot",
      });
      expect((await log.sink().send(owner.sessionId, { reviews, snoozes: [] })).ok).toBe(true);
    }
  });

  it("undoes, snoozes, and wakes, and a reload folds the same writes back", async () => {
    const log = newLog();
    const sink = log.sink();
    const review = decisionReview({
      proposal: linked,
      entities: data.entities,
      decision: "rejected",
      timing: TIMING,
      input: "pointer",
      surface: "pilot",
    });
    await sink.send(session.sessionId, { reviews: [review], snoozes: [] });
    const reopen = undoReview({
      proposal: linked,
      entities: data.entities,
      undoes: review.reviewId,
      input: "keyboard",
      surface: "pilot",
    });
    expect((await sink.send(session.sessionId, { reviews: [reopen], snoozes: [] })).ok).toBe(true);
    const other = session.proposals.find((p) => p.proposalId !== linked.proposalId);
    if (!other) throw new Error("s01 has one card");
    await sink.send(session.sessionId, {
      reviews: [],
      snoozes: [snoozeOf(other.proposalId, new Date("2026-12-02T09:00:00.000Z"))],
    });
    const folded = log.sessions()[0]?.proposals ?? [];
    expect(folded.find((p) => p.proposalId === linked.proposalId)?.status).toBe("proposed");
    expect(folded.find((p) => p.proposalId === other.proposalId)?.snoozedUntil).toBe(
      "2026-12-02T09:00:00.000Z",
    );
    // A reload: the stored writes fold into the same state.
    const again = new LocalReviewLog([session], log.events(), { participant: "P1" });
    expect(again.sessions()).toEqual(log.sessions());
    expect(again.reviews()).toEqual(log.reviews());
  });
});

describe("the progress in sessionStorage", () => {
  const storage = () => {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
    };
  };
  const progress: PilotProgress = {
    v: 1,
    setSha256: manifest.sha256,
    participant: "P2",
    startedAt: NOW.toISOString(),
    phase: "practice",
    practice: [],
    events: [],
  };

  it("keeps a participant's place under their label, for this set only", () => {
    const store = storage();
    writeProgress(store, progress);
    expect([...store.map.keys()]).toEqual([progressKey("P2")]);
    expect(readProgress(store, "P2", manifest.sha256)).toEqual(progress);
    expect(readProgress(store, "P3", manifest.sha256)).toBeNull();
    expect(readProgress(store, "P2", "0".repeat(64))).toBeNull();
    store.map.set(progressKey("P2"), "{not json");
    expect(readProgress(store, "P2", manifest.sha256)).toBeNull();
  });

  it("survives a storage that refuses", () => {
    const refusing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(readProgress(refusing, "P1", manifest.sha256)).toBeNull();
    expect(() => writeProgress(refusing, progress)).not.toThrow();
  });
});

describe("the results file", () => {
  it("holds §4.8's fields and nothing else, and pilot:analyze reads it", async () => {
    const session = data.sessions[0]?.session;
    if (!session) throw new Error("no s01");
    const log = new LocalReviewLog([session], [], { participant: "P1", now: () => NOW });
    for (const proposal of session.proposals) {
      if (proposal.target.decision === "ask" || proposal.target.decision === "none") continue;
      const review = decisionReview({
        proposal,
        entities: data.entities,
        decision: "approved",
        timing: TIMING,
        input: "keyboard",
        surface: "pilot",
      });
      await log.sink().send(session.sessionId, { reviews: [review], snoozes: [] });
    }
    const file = resultsFile({
      set: data.set,
      setSha256: data.setSha256,
      participant: "P1",
      order: data.orders["1"] ?? [],
      startedAt: NOW.toISOString(),
      finishedAt: "2026-12-01T10:30:00.000Z",
      browser: { engine: "blink", mobile: false },
      reviews: log.reviews(),
      practice: [],
    });
    expect(Object.keys(file)).toEqual([
      "format",
      "set",
      "setSha256",
      "participant",
      "order",
      "startedAt",
      "finishedAt",
      "browser",
      "reviews",
      "practice",
    ]);
    expect(Object.keys(file.browser)).toEqual(["engine", "mobile"]);
    const text = resultsText(file);
    expect(PilotResults.parse(JSON.parse(text))).toEqual(JSON.parse(text));
    const analysis = analyzePilot([{ name: "P1.json", text }], manifest);
    expect(analysis.rejected).toEqual([]);
    expect(analysis.participants[0]?.single).toHaveLength(log.reviews().length);
  });

  it("names the browser by engine and phone or tablet, from a user agent it doesn't keep", () => {
    const chrome =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
    const firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0";
    const safari =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15";
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0 Mobile/15E148 Safari/604.1";
    const android =
      "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";
    expect(browserOf({ userAgent: chrome, maxTouchPoints: 0 })).toEqual({
      engine: "blink",
      mobile: false,
    });
    expect(browserOf({ userAgent: firefox })).toEqual({ engine: "gecko", mobile: false });
    expect(browserOf({ userAgent: safari, maxTouchPoints: 0 })).toEqual({
      engine: "webkit",
      mobile: false,
    });
    expect(browserOf({ userAgent: iphone })).toEqual({ engine: "webkit", mobile: true });
    // An iPad asks for the desktop site: a Mac with a touch screen.
    expect(browserOf({ userAgent: safari, maxTouchPoints: 5 })).toEqual({
      engine: "webkit",
      mobile: true,
    });
    expect(browserOf({ userAgent: android })).toEqual({ engine: "blink", mobile: true });
    expect(browserOf({ userAgent: chrome, userAgentData: { mobile: true } }).mobile).toBe(true);
    expect(browserOf({ userAgent: "curl/8" })).toEqual({ engine: "unknown", mobile: false });
  });

  it("is named for the participant and their local date", () => {
    expect(resultsFileName("P3", new Date(2026, 11, 1, 23, 59))).toBe(
      "earshot-pilot-P3-2026-12-01.json",
    );
  });
});

describe("the consent screen", () => {
  const markdown = readFileSync(findInRepo("docs/pilot/consent.md"), "utf8");

  it("shows docs/pilot/consent.md word for word, its own heading first", () => {
    const blocks = consentBlocks(markdown);
    expect(blocks[0]).toMatchObject({ kind: "h1" });
    expect(blocks[0]?.kind !== "ul" && blocks[0]?.inline.map((part) => part.text).join("")).toBe(
      "The review pilot: consent",
    );
    // The file's words with Markdown's markers taken out, in order.
    const words = markdown
      .split("\n")
      .map((line) => line.replace(/^#{1,2} /, "").replace(/^- /, ""))
      .join(" ")
      .replaceAll("*", "")
      .split(/\s+/)
      .filter((word) => word !== "");
    expect(consentWords(blocks)).toEqual(words);
    expect(blocks.filter((block) => block.kind === "h2").length).toBeGreaterThan(3);
    expect(blocks.some((block) => block.kind === "ul")).toBe(true);
  });

  it("refuses Markdown it would show wrongly", () => {
    for (const line of [
      "**bold**",
      "a [link](https://example.com)",
      "1. first",
      "> quote",
      "`x`",
    ]) {
      expect(() => consentBlocks(`# Consent\n\n${line}\n`), line).toThrow(/doesn't read/);
    }
    expect(() => consentBlocks("an *unclosed emphasis")).toThrow(/unclosed/);
  });
});

describe("?p=", () => {
  it("is P1 to P5 with their orders' keys, or ci, and nothing else", () => {
    expect(participantOf("1")).toEqual({ label: "P1", key: "1" });
    expect(participantOf("5")).toEqual({ label: "P5", key: "5" });
    expect(participantOf("ci")).toEqual({ label: "ci", key: "ci" });
    for (const p of ["0", "6", "P1", "", null, undefined]) expect(participantOf(p)).toBeNull();
  });
});
