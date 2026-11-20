// The pilot set, pilot.v1 (Phase 5 spec WP7 step 1; ADR-0039): the builder reproduces the
// committed files byte for byte, the set holds exactly 4 flagged and 4 silent wrong accounts as the
// spec writes them (each silent error's right record among its candidates, second), no silent error
// touches its session's open account on either side, the silent errors spread over as many
// confusable groups as the eligible sessions allow, `tierOf` makes every flagged one loud and gives
// every silent one the name note and nothing louder, the logs are what SessionDO writes and replay,
// the manifest's hashes hold, and the orders are a balanced Latin rectangle.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { EventEnvelope } from "@earshot/core";
import { contacts, deals } from "@earshot/demo-crm";
import { defaultProjections, fromJsonl, type ProposalView, replay } from "@earshot/events";
import { tierOf } from "@earshot/understanding/tiers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  cassetteFileUrl,
  errorsSha256,
  readErrorLabels,
  readUnderstandingCassettes,
  scriptsSha256,
} from "../scripts/understanding-io";
import { createRng } from "../src/channel/rng";
import {
  balancedLatinRectangle,
  manifestText,
  orderKey,
  PILOT_FLAGGED,
  PILOT_SILENT,
  PilotManifest,
  participantLabel,
  SILENT_P_RANGE,
  setSha256,
  williamsRow,
} from "../src/pilot";
import { bestSpread, buildPilotSet, inOpenAccount, type PilotSet } from "../src/pilot/build";
import { ALL_DEBRIEFS } from "../src/understanding";

const DIR = new URL("../pilot/pilot.v1/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, DIR), "utf8");
const manifest = PilotManifest.parse(JSON.parse(read("manifest.json")));

interface Session {
  readonly id: string;
  readonly events: EventEnvelope[];
  readonly proposals: readonly ProposalView[];
}

const sessions: Session[] = [...manifest.sessions, manifest.practice].map((entry) => {
  const events = fromJsonl(read(entry.file));
  return { id: entry.id, events, proposals: replay(events, defaultProjections).proposals };
});

function proposal(proposalId: string): ProposalView {
  for (const session of sessions) {
    const found = session.proposals.find((view) => view.proposalId === proposalId);
    if (found) return found;
  }
  throw new Error(`no proposal ${proposalId}`);
}

/** The biased utterance a proposal's target was named in, by id. */
function utteranceText(proposalId: string, utteranceId: string): string {
  for (const session of sessions) {
    if (!session.proposals.some((view) => view.proposalId === proposalId)) continue;
    const event = session.events.find(
      (candidate) =>
        candidate.type === "utterance.final" &&
        (candidate.payload as { utteranceId: string }).utteranceId === utteranceId,
    );
    if (event) return (event.payload as { text: string }).text;
  }
  throw new Error(`no utterance ${utteranceId}`);
}

const silentErrors = manifest.seeded.flatMap((error) => (error.kind === "silent" ? [error] : []));

describe("the pilot set's builder", () => {
  let built: PilotSet;
  beforeAll(async () => {
    built = await buildPilotSet({
      scripts: ALL_DEBRIEFS,
      cassettes: readUnderstandingCassettes().anthropic,
      labels: readErrorLabels(),
      hashes: {
        scriptsSha256: scriptsSha256(),
        errorsSha256: errorsSha256(),
        cassetteSha256: createHash("sha256")
          .update(readFileSync(cassetteFileUrl("anthropic")))
          .digest("hex"),
      },
    });
  }, 120_000); // a second or two here; CI's runners under turbo are far slower

  it("reproduces the committed pilot/pilot.v1 byte for byte (run `pnpm --filter @earshot/evals pilot:gen` after changing it, and never once the pilot has begun)", () => {
    expect([...built.files.keys()].sort()).toEqual(readdirSync(DIR).sort());
    for (const [name, text] of built.files) expect(text, name).toBe(read(name));
  });

  it("spreads the silent errors over as many confusable groups as the eligible sessions allow", () => {
    const pool = built.silentPool;
    // The widest spread is worked out again from the pool: 4 of its sessions, each taking one of
    // its own groups.
    expect(
      bestSpread(
        pool.sessions.map((session) => session.groups),
        PILOT_SILENT,
      )?.distinct,
    ).toBe(pool.widest);
    const groups = silentErrors.map((error) => error.group);
    expect(new Set(groups).size).toBe(pool.widest);
    // Each carrier is in the pool, and its error's group is one its session offers.
    for (const error of silentErrors) {
      const session = pool.sessions.find((candidate) => candidate.script === error.script);
      expect(session?.groups, error.script).toContain(error.group);
    }
  });
});

describe("the silent recipe's rules", () => {
  it("knows a session's open account and everything in it: the account, its contacts, its deals", () => {
    const contact = contacts[0];
    const deal = deals[0];
    if (!contact || !deal) throw new Error("the demo CRM is empty");
    expect(inOpenAccount(contact.companyId, contact.companyId)).toBe(true);
    expect(inOpenAccount(contact.id, contact.companyId)).toBe(true);
    expect(inOpenAccount(deal.id, deal.companyId)).toBe(true);
    const other = contacts.find((row) => row.companyId !== contact.companyId);
    expect(other && inOpenAccount(other.id, contact.companyId)).toBe(false);
    expect(inOpenAccount(contact.id, null)).toBe(false);
  });

  it("spreads choices over distinct groups when it can, as few repeats as it must, ties to the given order", () => {
    // Four sessions, four groups: all of them.
    expect(bestSpread([["a"], ["b"], ["c"], ["d"]], 4)).toEqual({
      picks: [0, 1, 2, 3],
      groups: ["a", "b", "c", "d"],
      distinct: 4,
    });
    // A second session in a group is passed over when another group is there to take.
    expect(bestSpread([["a"], ["a"], ["b"], ["c"], ["d"]], 4)?.picks).toEqual([0, 2, 3, 4]);
    // Only three groups among them: one repeat, the earliest choice that has just one.
    expect(bestSpread([["a"], ["a"], ["a"], ["b"], ["c"]], 4)).toEqual({
      picks: [0, 1, 3, 4],
      groups: ["a", "a", "b", "c"],
      distinct: 3,
    });
    // A session with candidates in two groups takes the one that spreads.
    expect(bestSpread([["a"], ["a", "b"], ["c"], ["d"]], 4)?.groups).toEqual(["a", "b", "c", "d"]);
    // Equally spread choices: the earliest in the order given, which the seed sets.
    expect(bestSpread([["a"], ["b"], ["a"], ["b"], ["c"], ["d"]], 4)?.picks).toEqual([0, 1, 4, 5]);
    expect(bestSpread([["a"], ["b"]], 4)).toBeNull();
  });
});

describe("pilot.v1", () => {
  it("is 10 sessions with 40 proposals between them, and a 3-card practice", () => {
    expect(manifest.sessions.map((session) => session.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `s${String(i + 1).padStart(2, "0")}`),
    );
    const main = sessions.slice(0, 10);
    expect(main.reduce((sum, session) => sum + session.proposals.length, 0)).toBe(40);
    for (const [index, session] of main.entries()) {
      expect(session.proposals.map((view) => view.proposalId)).toEqual(
        manifest.sessions[index]?.proposals,
      );
    }
    expect(sessions[10]?.proposals).toHaveLength(3);
    // The practice comes from the hand-written scripts and carries no seeded error.
    expect(Number(manifest.practice.script.slice(1))).toBeLessThanOrEqual(30);
    const practiceIds = new Set(manifest.practice.proposals);
    expect(manifest.seeded.some((error) => practiceIds.has(error.proposalId))).toBe(false);
    // Different debriefs throughout, and no id shared between sessions.
    const scripts = [...manifest.sessions, manifest.practice].map((session) => session.script);
    expect(new Set(scripts).size).toBe(11);
    const ids = sessions.flatMap((session) => session.proposals.map((view) => view.proposalId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("logs each session as SessionDO writes it, ending in its seal", () => {
    for (const session of sessions) {
      const types = session.events.map((event) => event.type);
      expect(types[0], session.id).toBe("session.started");
      expect(types.slice(-2), session.id).toEqual(["session.ended", "session.sealed"]);
      expect(session.events.at(-1)?.payload).toMatchObject({ by: "session" });
      // Per turn: the stream's words, the proposals, the cost, the turn; then the second witness.
      const turns = types.filter((type) => type === "turn.completed").length;
      expect(types.filter((type) => type === "turn.witnessed")).toHaveLength(turns);
      expect(types.filter((type) => type === "utterance.final")).toHaveLength(2 * turns);
      expect(replay(session.events, defaultProjections).session?.sealedAt).not.toBeNull();
    }
  });

  it("holds exactly 4 flagged and 4 silent wrong accounts, at most one per session", () => {
    const kinds = manifest.seeded.map((error) => error.kind);
    expect(kinds.filter((kind) => kind === "flagged")).toHaveLength(PILOT_FLAGGED);
    expect(kinds.filter((kind) => kind === "silent")).toHaveLength(PILOT_SILENT);
    const bySession = manifest.seeded.map((error) => error.session);
    expect(new Set(bySession).size).toBe(8);
    const flaggedIds = new Set(
      manifest.tiers.proposals.filter((p) => p.seeded === "flagged").map((p) => p.proposalId),
    );
    const silentIds = new Set(
      manifest.tiers.proposals.filter((p) => p.seeded === "silent").map((p) => p.proposalId),
    );
    expect(flaggedIds.size).toBe(4);
    expect(silentIds.size).toBe(4);
  });

  it("flags each flagged error as the pipeline did: a question, the snapped record first, New on offer, and loud", () => {
    for (const error of manifest.seeded) {
      if (error.kind !== "flagged") continue;
      const view = proposal(error.proposalId);
      expect(view.target.decision).toBe("ask");
      expect(view.target.candidates[0]?.entityId).toBe(error.snapped);
      expect(view.target.candidates).toEqual(error.candidates);
      expect(view.riskFlags).toContainEqual({ kind: "witness_conflict", field: "target" });
      // "New" is one of the numbered choices (p ≥ 0.05, among the first four), so it's reachable.
      const offered = view.target.candidates.filter((candidate) => candidate.p >= 0.05).slice(0, 4);
      expect(offered.some((candidate) => candidate.entityId === null)).toBe(true);
      expect(error.right).toEqual({ entityId: null });
      const tier = tierOf(view);
      expect(tier.tier).toBe("loud");
      expect(tier.reasons[0]).toMatchObject({ tier: "loud", kind: "witness_conflict" });
    }
  });

  it("swaps each silent error to a sound-alike, the right record second, with the name note and nothing louder", () => {
    for (const error of manifest.seeded) {
      if (error.kind !== "silent") continue;
      const view = proposal(error.proposalId);
      const { target } = view;
      expect(target).toMatchObject({ decision: "linked", entityId: error.shown, basis: "sound" });
      expect(target.p).toBe(error.p);
      expect(error.p).toBeGreaterThanOrEqual(SILENT_P_RANGE[0]);
      expect(error.p).toBeLessThanOrEqual(SILENT_P_RANGE[1]);
      expect(view.riskFlags).toEqual([{ kind: "link_uncertain", field: "target" }]);
      // The right record is among the candidates: second, below the sibling shown.
      expect(target.candidates.map((candidate) => candidate.entityId)).toContain(
        error.right.entityId,
      );
      expect(target.candidates[1]?.entityId).toBe(error.right.entityId);
      expect(target.candidates[0]).toEqual({ entityId: error.shown, p: error.p });
      expect(target.candidates[1]?.p).toBeLessThan(error.p);
      expect(error.shown).not.toBe(error.right.entityId);
      // The quote stays what the rep said: the words at its evidence.
      const mention = target.mention;
      expect(mention).not.toBeNull();
      if (mention) {
        const text = utteranceText(view.proposalId, mention.evidence.utteranceId);
        expect(text.slice(mention.evidence.span[0], mention.evidence.span[1])).toBe(mention.quote);
      }
      const tier = tierOf(view);
      expect(tier).toEqual({ tier: "quiet", reasons: [], nameNote: "sound" });
    }
  });

  it("keeps every silent error off its session's open account, on both sides: the record named and the record shown", () => {
    const companyOf = new Map<string, string>([
      ...contacts.map((row) => [row.id, row.companyId] as const),
      ...deals.map((row) => [row.id, row.companyId] as const),
    ]);
    const inAccount = (id: string, open: string | null) =>
      open !== null && (id === open || companyOf.get(id) === open);
    expect(silentErrors).toHaveLength(PILOT_SILENT);
    for (const error of silentErrors) {
      const open = manifest.sessions.find((session) => session.id === error.session)?.focusEntityId;
      expect(open, error.session).not.toBeUndefined();
      expect(inAccount(error.right.entityId, open ?? null), `${error.session} named`).toBe(false);
      expect(inAccount(error.shown, open ?? null), `${error.session} shown`).toBe(false);
    }
  });

  it("reports the tier mix of every card as `tierOf` reads it, never tuned", () => {
    for (const entry of manifest.tiers.proposals) {
      const tier = tierOf(proposal(entry.proposalId));
      expect(entry.tier, entry.proposalId).toBe(tier.tier);
      expect(entry.nameNote, entry.proposalId).toBe(tier.nameNote);
      expect(entry.reasons).toHaveLength(tier.reasons.length);
    }
    const { all, seeded, other, practice } = manifest.tiers;
    for (const counts of [all, seeded, other, practice]) {
      expect(counts.loud + counts.quiet + counts.nameNote + counts.none).toBe(counts.proposals);
    }
    expect(all.proposals).toBe(40);
    expect(seeded).toMatchObject({ proposals: 8, loud: 4, nameNote: 4 });
    expect(other.proposals).toBe(32);
    expect(all.loud).toBe(seeded.loud + other.loud);
    expect(practice.proposals).toBe(3);
  });

  it("carries its own hash, which covers every log", async () => {
    expect(await setSha256(JSON.parse(read("manifest.json")))).toBe(manifest.sha256);
    for (const entry of [...manifest.sessions, manifest.practice]) {
      const hash = createHash("sha256")
        .update(readFileSync(new URL(entry.file, DIR)))
        .digest("hex");
      expect(hash, entry.file).toBe(entry.sha256);
    }
    expect(manifestText(manifest)).toBe(read("manifest.json"));
    // One byte changed in the body changes the hash.
    const tampered = { ...JSON.parse(read("manifest.json")), seed: manifest.seed + 1 };
    expect(await setSha256(tampered)).not.toBe(manifest.sha256);
  });

  it("gives each participant an order of their own: a balanced Latin rectangle, and CI s01 to s10", () => {
    const ids = manifest.sessions.map((session) => session.id);
    const rows = (["1", "2", "3", "4", "5"] as const).map((key) => manifest.orders[key]);
    for (const row of rows) expect([...row].sort()).toEqual(ids);
    // Every position holds a different session in each order.
    for (let position = 0; position < ids.length; position++) {
      expect(new Set(rows.map((row) => row[position])).size).toBe(rows.length);
    }
    // No session directly follows the same one in two orders.
    const pairs = rows.flatMap((row) => row.slice(1).map((id, i) => `${row[i]}>${id}`));
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(manifest.orders.ci).toEqual(ids);
    expect(new Set(rows.map((row) => row.join(" "))).size).toBe(5);
  });
});

describe("the orders' design", () => {
  it("builds Williams squares whose rows hold every ordered pair once", () => {
    for (const n of [2, 4, 10]) {
      const square = Array.from({ length: n }, (_, r) => williamsRow(n, r));
      const pairs = square.flatMap((row) => row.slice(1).map((s, i) => `${row[i]}>${s}`));
      expect(new Set(pairs).size).toBe(n * (n - 1));
      for (let column = 0; column < n; column++) {
        expect(new Set(square.map((row) => row[column])).size).toBe(n);
      }
    }
    expect(williamsRow(10, 0)).toEqual([0, 1, 9, 2, 8, 3, 7, 4, 6, 5]);
    expect(() => williamsRow(5, 0)).toThrow(RangeError);
  });

  it("draws the same rectangle from the same seed", () => {
    const labels = ["a", "b", "c", "d"];
    expect(balancedLatinRectangle(labels, 3, createRng(7))).toEqual(
      balancedLatinRectangle(labels, 3, createRng(7)),
    );
    expect(() => balancedLatinRectangle(labels, 5, createRng(7))).toThrow(RangeError);
  });

  it("reads ?p= as P1 to P5 or ci, and nothing else", () => {
    expect(["1", "5", "ci", "0", "6", "", null, "p1"].map(participantLabel)).toEqual([
      "P1",
      "P5",
      "ci",
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(["P1", "P5", "ci", "P6", "1"].map(orderKey)).toEqual(["1", "5", "ci", null, null]);
  });
});
