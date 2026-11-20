// `pilot:analyze` (Phase 5 spec WP7 step 3; docs/pilot/pre-registration.md) on hand-made results
// files: each participant's median handlingMs over single-mode decisions, the median of the
// medians with its min and max, a short session reported but left out of the medians, batches
// counted once by batchId with their undos left out, final decisions for the catch rate (caught
// after accepting included), 36 of 40 giving 76.3–97.2%, and the checks: another set's file, a
// file that isn't JSON, an order other than the manifest's, practice kept apart.
import { readFileSync } from "node:fs";
import type { ProposalReviewedV2, ReviewTarget } from "@earshot/core";
import { describe, expect, it } from "vitest";
import {
  analyzePilot,
  clopperPearson,
  median,
  nearestRank,
  PilotManifest,
  PilotResults,
  pilotAnalysisMarkdown,
  type SeededError,
} from "../src/pilot";

const manifest = PilotManifest.parse(
  JSON.parse(readFileSync(new URL("../pilot/pilot.v1/manifest.json", import.meta.url), "utf8")),
);
const tierOf = new Map(manifest.tiers.proposals.map((p) => [p.proposalId, p.tier]));
const seededIds = new Set(manifest.seeded.map((error) => error.proposalId));
const others = manifest.sessions.flatMap((s) => s.proposals).filter((id) => !seededIds.has(id));
const unmarked = others.filter((id) => tierOf.get(id) === "none");
const flagged = manifest.seeded.filter((error) => error.kind === "flagged");
const silent = manifest.seeded.filter(
  (error): error is Extract<SeededError, { kind: "silent" }> => error.kind === "silent",
);

let counter = 0;
function uuid(): string {
  counter += 1;
  return `00000000-0000-7000-8000-${counter.toString(16).padStart(12, "0")}`;
}

interface ReviewOptions {
  readonly ms?: number;
  readonly target?: ReviewTarget | null;
  readonly batchId?: string;
  readonly undoes?: string;
}

/** A review as the pilot page writes it, on the pilot surface. */
function review(
  proposalId: string,
  decision: ProposalReviewedV2["decision"],
  options: ReviewOptions = {},
): ProposalReviewedV2 {
  const decides = decision === "approved" || decision === "edited";
  const ms = options.ms ?? 0;
  return {
    reviewId: uuid(),
    proposalId,
    decision,
    target: options.target ?? null,
    ...(decision === "edited" ? { editDiff: { title: { before: "a", after: "b" } } } : {}),
    mode: options.batchId ? "batch" : "single",
    batchId: options.batchId ?? null,
    policy: null,
    undoes: options.undoes ?? null,
    reason: decision === "reopened" ? "undo" : null,
    seen: {
      tier: tierOf.get(proposalId) ?? "none",
      fields: {},
      target: null,
      relinked: null,
      clip: "none",
    },
    timing: { decisionMs: ms, handlingMs: ms },
    input: "keyboard",
    surface: "pilot",
    syncEligibleAt: decides ? "2026-12-01T10:00:30.000Z" : null,
    by: { userId: "P1", auth: null },
  };
}

/** The right answer for a seeded error, at `ms`. */
function caughtReview(error: SeededError, ms: number): ProposalReviewedV2 {
  return review(error.proposalId, "approved", { ms, target: { entityId: error.right.entityId } });
}

/** A miss: a flagged error answered with its snapped record, a silent one accepted as it stands. */
function missedReview(error: SeededError, ms: number): ProposalReviewedV2 {
  return error.kind === "flagged"
    ? review(error.proposalId, "approved", { ms, target: { entityId: error.snapped } })
    : review(error.proposalId, "approved", { ms });
}

function results(
  participant: "P1" | "P2" | "P3" | "P4" | "P5",
  reviews: ProposalReviewedV2[],
  options: { order?: string[]; practice?: ProposalReviewedV2[]; setSha256?: string } = {},
): PilotResults {
  const key = participant.slice(1) as "1" | "2" | "3" | "4" | "5";
  return PilotResults.parse({
    format: 1,
    set: "pilot.v1",
    setSha256: options.setSha256 ?? manifest.sha256,
    participant,
    order: options.order ?? manifest.orders[key],
    startedAt: "2026-12-01T10:00:00.000Z",
    finishedAt: "2026-12-01T10:31:00.000Z",
    browser: { engine: "blink", mobile: false },
    reviews,
    practice: options.practice ?? [],
  });
}

/** Single-mode decisions on every other card at the given times, in order. */
function decideOthers(ids: readonly string[], times: (index: number) => number) {
  return ids.map((id, index) => review(id, "approved", { ms: times(index) }));
}

// P1: 40 single decisions, half at 1,000 ms and half at 2,000: median 1,500. Catches all 8.
const p1 = results(
  "P1",
  [
    ...decideOthers(others, (i) => (i < 16 ? 1_000 : 2_000)),
    ...flagged.map((error) => caughtReview(error, 2_000)),
    ...silent.map((error) => caughtReview(error, 1_000)),
  ],
  {
    practice: manifest.practice.proposals.map((id) => review(id, "approved", { ms: 900 })),
  },
);

// P2: one batch of 3 unmarked cards (4,000 ms), and one of 2 (6,000 ms) undone and then decided
// one by one; every single decision at 3,000 ms: median 3,000. Misses one silent error.
const batchX = uuid();
const batchY = uuid();
const ySecond = unmarked.slice(3, 5);
const yApprovals = ySecond.map((id) => review(id, "approved", { ms: 6_000, batchId: batchY }));
const p2 = results("P2", [
  ...unmarked.slice(0, 3).map((id) => review(id, "approved", { ms: 4_000, batchId: batchX })),
  ...yApprovals,
  ...yApprovals.map((approval) =>
    review(approval.proposalId, "reopened", { batchId: batchY, undoes: approval.reviewId }),
  ),
  ...decideOthers(
    others.filter((id) => !unmarked.slice(0, 3).includes(id)),
    () => 3_000,
  ),
  ...flagged.map((error) => caughtReview(error, 3_000)),
  missedReview(silent[0] as SeededError, 3_000),
  ...silent.slice(1).map((error) => caughtReview(error, 3_000)),
]);

// P3: 40 single decisions, ten each at 2, 3, 4, and 5 s: median 3,500. Answers one flagged error
// with its snapped record, and reviews a practice card among the main reviews (a stray).
const times3 = (i: number) => [2_000, 3_000, 4_000, 5_000][i % 4] as number;
const p3 = results("P3", [
  ...decideOthers(others, times3),
  missedReview(flagged[0] as SeededError, 3_000),
  ...flagged.slice(1).map((error, i) => caughtReview(error, times3(i + 1))),
  ...silent.map((error, i) => caughtReview(error, times3(i + 3))),
  review(manifest.practice.proposals[0] as string, "approved", { ms: 1 }),
]);

// P4: the sessions in another order than assigned; 40 decisions at 4,500 ms. Misses 2 silent.
const p4 = results(
  "P4",
  [
    ...decideOthers(others, () => 4_500),
    ...flagged.map((error) => caughtReview(error, 4_500)),
    missedReview(silent[1] as SeededError, 4_500),
    missedReview(silent[2] as SeededError, 4_500),
    caughtReview(silent[0] as SeededError, 4_500),
    caughtReview(silent[3] as SeededError, 4_500),
  ],
  { order: [...manifest.orders["4"]].reverse() },
);

// P5: only 25 decisions (17 others and the 8 seeded), so out of the medians; catches all 8, one
// silent error only after accepting it as it stood, undoing, and choosing the right record (26
// single-mode decisions: the accept that missed counts as a decision and a time).
const firstSilent = silent[0] as SeededError;
const wrong = missedReview(firstSilent, 1_000);
const p5 = results("P5", [
  ...decideOthers(others.slice(0, 17), () => 1_000),
  ...flagged.map((error) => review(error.proposalId, "rejected", { ms: 1_000 })),
  wrong,
  review(firstSilent.proposalId, "reopened", { undoes: wrong.reviewId }),
  caughtReview(firstSilent, 1_000),
  ...silent.slice(1).map((error) => caughtReview(error, 1_000)),
]);

const files = [
  { name: "earshot-pilot-P3-2026-12-01.json", text: JSON.stringify(p3) },
  { name: "earshot-pilot-P1-2026-12-01.json", text: JSON.stringify(p1) },
  { name: "earshot-pilot-P2-2026-12-01.json", text: JSON.stringify(p2) },
  { name: "earshot-pilot-P5-2026-12-01.json", text: JSON.stringify(p5) },
  { name: "earshot-pilot-P4-2026-12-01.json", text: JSON.stringify(p4) },
  {
    name: "other-set.json",
    text: JSON.stringify({ ...p1, participant: "P2", setSha256: "0".repeat(64) }),
  },
  { name: "notes.txt", text: "not a results file" },
];

describe("the pilot's statistics", () => {
  it("takes medians, the middle two's mean for an even count", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1_000, 2_000, 1_000, 2_000])).toBe(1_500);
    expect(median([])).toBeNull();
  });

  it("takes a nearest-rank percentile, always one of the values", () => {
    const values = Array.from({ length: 10 }, (_, i) => (i + 1) * 100);
    expect(nearestRank(values, 0.9)).toBe(900);
    expect(nearestRank([5, 1, 9], 0.9)).toBe(9);
    expect(nearestRank([], 0.9)).toBeNull();
    expect(() => nearestRank([1], 0)).toThrow(RangeError);
  });

  it("gives the pre-registration's Clopper–Pearson intervals", () => {
    const interval = (k: number, n: number) => {
      const { lower, upper } = clopperPearson(k, n);
      return [(100 * lower).toFixed(1), (100 * upper).toFixed(1)];
    };
    expect(interval(36, 40)).toEqual(["76.3", "97.2"]);
    expect(interval(38, 40)).toEqual(["83.1", "99.4"]);
    expect(interval(39, 40)).toEqual(["86.8", "99.9"]);
    expect(interval(40, 40)).toEqual(["91.2", "100.0"]);
    expect(interval(0, 40)[0]).toBe("0.0");
  });
});

describe("pilot:analyze on hand-made results files", () => {
  const analysis = analyzePilot(files, manifest);
  const byLabel = new Map(analysis.participants.map((p) => [p.participant, p]));

  it("reads the five participants and leaves out what isn't theirs, saying why", () => {
    expect(analysis.participants.map((p) => p.participant)).toEqual(["P1", "P2", "P3", "P4", "P5"]);
    expect(analysis.rejected).toEqual([
      { file: "other-set.json", reason: `from another set (SHA-256 ${"0".repeat(64)})` },
      { file: "notes.txt", reason: "not JSON" },
    ]);
  });

  it("takes each participant's median over single-mode decisions, and leaves a short session out of the medians", () => {
    expect(byLabel.get("P1")).toMatchObject({ decisions: 40, median: 1_500, included: true });
    expect(byLabel.get("P1")?.single).toHaveLength(40);
    // P2's batch items aren't single decisions; the two cards its undone batch took are, after.
    expect(byLabel.get("P2")).toMatchObject({ decisions: 40, median: 3_000, included: true });
    expect(byLabel.get("P2")?.single).toHaveLength(37);
    expect(byLabel.get("P3")).toMatchObject({ decisions: 40, median: 3_500, included: true });
    expect(byLabel.get("P4")).toMatchObject({ decisions: 40, median: 4_500, included: true });
    expect(byLabel.get("P5")).toMatchObject({ decisions: 25, median: 1_000, included: false });
    // Each single decision is timed by the tier its card showed.
    for (const p of analysis.participants) {
      expect(p.loud.length + p.rest.length).toBe(p.single.length);
    }
    expect(byLabel.get("P1")?.loud).toHaveLength(manifest.tiers.all.loud);
  });

  it("counts each batch once by its batchId, from its approvals, and leaves its undo out", () => {
    const p2 = byLabel.get("P2");
    expect(p2?.batches).toEqual([
      { batchId: batchX, size: 3, ms: 4_000 },
      { batchId: batchY, size: 2, ms: 6_000 },
    ]);
    // Only the batch that stood decided its cards in the end.
    expect(p2?.batchDecided).toBe(3);
  });

  it("counts final decisions for the catch rate: 36 of 40, flagged and silent apart", () => {
    const caught = (label: string) =>
      byLabel.get(label)?.catches.filter((c) => c.caught).length ?? -1;
    expect(["P1", "P2", "P3", "P4", "P5"].map(caught)).toEqual([8, 7, 7, 6, 8]);
    const p5 = byLabel.get("P5");
    expect(p5?.catches.filter((c) => c.afterAccepting).map((c) => c.error.proposalId)).toEqual([
      firstSilent.proposalId,
    ]);
    expect(byLabel.get("P3")?.catches.find((c) => !c.caught)?.error.kind).toBe("flagged");
  });

  it("writes the report: the median of medians with its min and max, and the interval", () => {
    const markdown = pilotAnalysisMarkdown(analysis);
    expect(markdown).toContain(
      "**Median of the participants' medians: 3,250 ms** (min 1,500 ms, max 4,500 ms; n = 4). Under 4,000 ms: **yes**.",
    );
    expect(markdown).toContain("| P5 | 25 | 26 | 1,000 ms | no: fewer than 30 decisions |");
    expect(markdown).toContain(
      "**Caught: 36 of 40 (90.0%; 95% Clopper–Pearson 76.3%–97.2%).** At least 90.0% as a point estimate: **yes**.",
    );
    expect(markdown).toContain("- Flagged: 19 of 20 (95.0%;");
    expect(markdown).toContain("- Silent: 17 of 20 (85.0%;");
    expect(markdown).toContain("- Caught after accepting: 1 (counted as caught");
    expect(markdown).toContain("4 of 8 per participant, 20 of 40 pooled");
    expect(markdown).toContain(
      '**Decided in a batch:** 3 of 185 decided cards (1.6%) ended with an "accept all" approval, in 2 batches.',
    );
    expect(markdown).toContain("median 5,000 ms (min 4,000 ms, max 6,000 ms)");
    expect(markdown).toContain("| P4 | 6 of 8 | 4 of 4 | 2 of 4 | 0 |");
    expect(markdown).toContain("- P4 ran the sessions in an order other than the manifest's");
    expect(markdown).toContain("- P3's file holds 1 reviews of cards outside the set (ignored).");
    expect(markdown).toContain("- Left out `other-set.json`: from another set");
    expect(markdown).toContain("- Practice reviews, kept apart and not analyzed: P1 3, P2 0");
  });

  it("says when the medians or the catch rate miss their thresholds", () => {
    const slow = results(
      "P1",
      decideOthers([...others, ...manifest.seeded.map((e) => e.proposalId)], () => 5_000),
    );
    const markdown = pilotAnalysisMarkdown(
      analyzePilot([{ name: "slow.json", text: JSON.stringify(slow) }], manifest),
    );
    expect(markdown).toContain("Under 4,000 ms: **no**.");
    // Accepting every card as it stands catches nothing: questions need a choice, links stay.
    expect(markdown).toContain("**Caught: 0 of 8 (0.0%;");
  });
});
