// The pilot set's builder (Phase 5 spec WP7 step 1, decision 13; ADR-0039): `pilot.v1`, 40
// proposals in 10 sessions from the 200 debriefs, with 4 flagged and 4 silent wrong accounts, a
// 3-card practice session, five participants' orders, and a manifest. scripts/gen-pilot.ts writes
// it to pilot/pilot.v1/, and a test rebuilds it and fails on any byte of difference.
//
// - **The logs.** Every one of the 200 runs through Phase 4's offline runner on the Anthropic
//   cassettes (`runScript`), so each session's log is what SessionDO writes: per turn, the biased
//   utterance, the proposals, the usage, `turn.completed`, then the second witness's utterance, its
//   flags, and `turn.witnessed`; then `session.ended` and `session.sealed`. The ids are rewritten
//   per session, so no two sessions share one, and the clocks are fixed (the call time, the
//   runner's utterance offsets, a latency of 0), so a rebuild is byte for byte the same.
// - **Flagged (4):** from the 48 snapped-name scripts, the proposal whose snapped name the
//   pipeline's own witness conflict turned into a question with the snapped record first, as it
//   came out. Caught means "New" or a rejection, so the question must offer "New" among its
//   numbered choices.
// - **Silent (4):** a correct, unmarked link to a company or contact in a sound-alike confusable
//   group (phonetic or spelling), swapped to a sibling: `basis: "sound"`, p drawn from 0.88–0.93,
//   the right record second, and only `link_uncertain:target`. The quote stays what the rep said.
//   Neither the record named nor the sibling shown may be the session's open account or belong to
//   it (a contact or deal of it): linker v1's open-account and family priors decide such a link by
//   context, never by sound. Caught means the right record, or a rejection.
// - **What else is chosen, and how.** A seeded draw of 4 snapped-name scripts and 6 others whose
//   proposals total 40, with a silent candidate in at least 4 of the 6; one seeded error per
//   session at most. The 32 other proposals keep the 200's natural mix, cassette errors included,
//   and the manifest reports their tiers; nothing about tiers enters the draw. Two kinds of script
//   are left out of it, so the 8 seeded errors are the only wrong accounts a participant meets:
//   the other snapped-name scripts (each holds an unseeded flagged wrong account), and any script
//   whose run links a record other than the ground truth's (d037's hidden wrong account, for one).
// - **The practice:** a hand-written script (d001–d030) with exactly 3 proposals and no seeded
//   error of any kind.
// - **Orders:** a seeded, balanced Latin rectangle (latin.ts) for P1 to P5; CI's is s01 to s10.
//
// If the 200 can't supply the errors as written, the builder throws rather than loosen the recipe.

import { LLM_MODELS } from "@earshot/agent";
import type { CassetteFile } from "@earshot/agent/testing";
import type {
  EventEnvelope,
  ProposalCreatedV2,
  TargetCandidate,
  TargetV2,
  UtteranceFinalV2,
} from "@earshot/core";
import { confusables, contacts, deals } from "@earshot/demo-crm";
import { defaultProjections, fromJsonl, replay, toJsonl } from "@earshot/events";
import { LINKER_PARAMS_V1 } from "@earshot/understanding/link";
import { type Tier, tierOf } from "@earshot/understanding/tiers";
import { createRng, subSeed } from "../channel/rng";
import { DEBRIEF_FILES } from "../debriefs";
import type { DebriefScript, ExpectedProposal } from "../schema";
import { sessionContext } from "../session";
import type { ErrorLabels } from "../understanding/cassettes";
import { matchTurn } from "../understanding/metrics";
import { type FinalProposal, runScript, type ScriptRun } from "../understanding/run";
import { balancedLatinRectangle } from "./latin";
import {
  CI_PARTICIPANT,
  type ManifestSession,
  manifestText,
  PILOT_FLAGGED,
  PILOT_PARTICIPANTS,
  PILOT_PRACTICE_COUNT,
  PILOT_PROPOSAL_COUNT,
  PILOT_PROVIDER,
  PILOT_SEED,
  PILOT_SESSION_COUNT,
  PILOT_SET,
  PILOT_SILENT,
  type PilotManifest,
  PilotManifest as PilotManifestSchema,
  type ProposalTier,
  type SeededError,
  SILENT_P_RANGE,
  setSha256,
  sha256Hex,
  type TierCounts,
} from "./set";

/** A question offers the records at least this likely (the tray's `ASK_MIN_P`), at most four. */
const CHOICE_MIN_P = 0.05;
const MAX_CHOICES = 4;
/** The most candidates a target lists (`MAX_TARGET_CANDIDATES`). */
const MAX_CANDIDATES = 4;
/** Draws of the session lottery before the builder gives up: far more than it ever needs. */
const MAX_DRAWS = 100_000;
/** Confusable groups whose members sound alike; shared stems and abbreviations don't. */
const SOUND_ALIKE = new Set(["phonetic", "spelling"]);

/** The speech-to-text provider the logs name: Phase 3's default. */
const SPEECH_TO_TEXT = { provider: "assemblyai", model: "universal-streaming-english" } as const;
/** The second witness the logs name (`@earshot/voice`'s `WITNESS_MODEL`). */
const WITNESS = { provider: "groq", model: "whisper-large-v3-turbo" } as const;
/** SessionDO seals 60 s after `end` (spec §4.3, target). */
const SEAL_GRACE_MS = 60_000;

export interface PilotInputs {
  /** The 200 debriefs, d001–d200. */
  readonly scripts: readonly DebriefScript[];
  /** The understanding cassettes for the Anthropic adapter. */
  readonly cassettes: CassetteFile;
  /** The cassettes' seeded, labelled errors. */
  readonly labels: ErrorLabels;
  /** What the set was built from, for the manifest; the caller hashes the files on disk. */
  readonly hashes: {
    readonly scriptsSha256: string;
    readonly errorsSha256: string;
    readonly cassetteSha256: string;
  };
}

export interface PilotSet {
  /** File name → text: `s01.jsonl` to `s10.jsonl`, `practice.jsonl`, and `manifest.json`. */
  readonly files: ReadonlyMap<string, string>;
  readonly manifest: PilotManifest;
  /**
   * The sessions that could carry a silent error (the draw's eligible pool), each with the
   * confusable groups its candidates are in, and the most distinct groups 4 of them allow: what the
   * silent errors' spread is held to. For the tests; not part of the set's files.
   */
  readonly silentPool: {
    readonly sessions: readonly { readonly script: string; readonly groups: readonly string[] }[];
    readonly widest: number;
  };
}

/** A proposal in a run, where it sits, and the ground truth it answers to. */
interface Slot {
  readonly turn: number;
  /** Its index among the turn's final proposals. */
  readonly index: number;
  /** Its index in the turn's `expect`, or -1 when nothing in the script matched it. */
  readonly expectedIndex: number;
  readonly final: FinalProposal;
  readonly expected: ExpectedProposal | null;
}

interface Analyzed {
  readonly script: DebriefScript;
  readonly run: ScriptRun;
  readonly slots: readonly Slot[];
  readonly snapped: boolean;
  readonly flagged: readonly Slot[];
  readonly silent: readonly Slot[];
  readonly wrongAccount: boolean;
  readonly labelled: boolean;
}

interface Swap {
  readonly slot: Slot;
  readonly shown: string;
  readonly p: number;
  readonly group: string;
  readonly candidates: readonly TargetCandidate[];
}

/** Every proposal of a run, matched to the script's expectations turn by turn. */
function slotsOf(run: ScriptRun): Slot[] {
  return run.turns.flatMap((turn, turnIndex) => {
    const expected = run.script.turns[turnIndex]?.expect ?? [];
    const matches = matchTurn(expected, turn.final);
    return turn.final.map((final, index): Slot => {
      const expectedIndex = matches.indexOf(index);
      return {
        turn: turnIndex,
        index,
        expectedIndex,
        final,
        expected: expectedIndex >= 0 ? (expected[expectedIndex] ?? null) : null,
      };
    });
  });
}

function hasLabel(labels: ErrorLabels, script: string, slot: Slot): boolean {
  return labels.errors.some(
    (error) =>
      error.script === script && error.turn === slot.turn && error.proposal === slot.expectedIndex,
  );
}

function expectsConflict(expected: ExpectedProposal | null): boolean {
  return (
    expected !== null &&
    "expectFlags" in expected &&
    (expected.expectFlags?.includes("witness_conflict") ?? false)
  );
}

/** A snapped new name: the ground truth is a new record, asked about through the witness. */
function isSnappedName(slot: Slot): boolean {
  return (
    slot.expected !== null &&
    slot.expected.target.id === null &&
    slot.expected.target.decision === "ask" &&
    expectsConflict(slot.expected)
  );
}

/** The records a question numbers, as the card does (`askCandidates`, sliced to four). */
function numberedChoices(target: TargetV2): readonly TargetCandidate[] {
  const likely = target.candidates.filter((candidate) => candidate.p >= CHOICE_MIN_P);
  return (likely.length > 0 ? likely : target.candidates.slice(0, 1)).slice(0, MAX_CHOICES);
}

/**
 * A flagged error as the spec writes it: a snapped name the witness's conflict turned into a
 * question, the snapped record first, "New" among the numbered choices, and no cassette error.
 */
function isFlaggedCandidate(script: string, slot: Slot, labels: ErrorLabels): boolean {
  const { target, riskFlags } = slot.final;
  const first = target.candidates[0];
  return (
    isSnappedName(slot) &&
    target.decision === "ask" &&
    riskFlags.some((flag) => flag.kind === "witness_conflict" && flag.field === "target") &&
    first !== undefined &&
    first.entityId !== null &&
    numberedChoices(target).some((candidate) => candidate.entityId === null) &&
    !hasLabel(labels, script, slot)
  );
}

/** The confusable groups by member id. */
const GROUP_OF: ReadonlyMap<string, (typeof confusables)[number]> = new Map(
  confusables.flatMap((group) => group.memberIds.map((id) => [id, group] as const)),
);

/** Each contact's and deal's company, in the demo CRM. */
const ACCOUNT_OF: ReadonlyMap<string, string> = new Map([
  ...contacts.map((row) => [row.id, row.companyId] as const),
  ...deals.map((row) => [row.id, row.companyId] as const),
]);

/**
 * Whether a record is the session's open account or belongs to it: the account itself, or a
 * contact or deal whose company it is. Linker v1's open-account and family priors decide a link
 * there by context, never by sound, so a silent error touches neither side of one: the record the
 * rep named, or the sibling the card shows.
 */
export function inOpenAccount(entityId: string, openAccount: string | null): boolean {
  if (openAccount === null) return false;
  return entityId === openAccount || ACCOUNT_OF.get(entityId) === openAccount;
}

/** The siblings a silent error may show: the group's other members outside the open account. */
function siblingsOf(right: string, openAccount: string | null): string[] {
  const group = GROUP_OF.get(right);
  if (!group) return [];
  return group.memberIds.filter((id) => id !== right && !inOpenAccount(id, openAccount)).sort();
}

/**
 * A silent error's source: a correct link to a company or contact in a sound-alike group, with no
 * flag at all (so the swap leaves only `link_uncertain`), no company named with it (the swap would
 * contradict it), and no cassette error; and neither it nor the sibling it would show is the
 * session's open account or belongs to it (`inOpenAccount`).
 */
function isSilentCandidate(script: DebriefScript, slot: Slot, labels: ErrorLabels): boolean {
  const { target, riskFlags } = slot.final;
  const group = target.entityId === null ? undefined : GROUP_OF.get(target.entityId);
  const openAccount = script.focusEntityId ?? null;
  return (
    slot.expected !== null &&
    slot.expected.target.decision === "linked" &&
    target.decision === "linked" &&
    target.entityId !== null &&
    target.entityId === slot.expected.target.id &&
    (target.kind === "company" || target.kind === "contact") &&
    group !== undefined &&
    SOUND_ALIKE.has(group.confusion) &&
    riskFlags.length === 0 &&
    target.company === null &&
    !hasLabel(labels, script.id, slot) &&
    !inOpenAccount(target.entityId, openAccount) &&
    siblingsOf(target.entityId, openAccount).length > 0
  );
}

/** A link to a record other than the ground truth's: a wrong account the set didn't seed. */
function isWrongAccount(slot: Slot): boolean {
  return (
    slot.expected !== null &&
    slot.final.target.decision === "linked" &&
    slot.final.target.entityId !== slot.expected.target.id
  );
}

function analyze(run: ScriptRun, labels: ErrorLabels): Analyzed {
  const { script } = run;
  const slots = slotsOf(run);
  return {
    script,
    run,
    slots,
    snapped: script.turns.some((turn) => turn.expect.some(expectsConflict)),
    flagged: slots.filter((slot) => isFlaggedCandidate(script.id, slot, labels)),
    silent: slots.filter((slot) => isSilentCandidate(script, slot, labels)),
    wrongAccount: slots.some(isWrongAccount),
    labelled: labels.errors.some((error) => error.script === script.id),
  };
}

/** The draw: 4 snapped-name scripts and 6 others, 40 proposals, room for 4 silent errors. */
/** The confusable groups a session's silent candidates are in, each once, in order. */
function groupsOf(item: Analyzed): string[] {
  const groups = item.silent.map(
    (slot) => GROUP_OF.get(slot.final.target.entityId ?? "")?.id ?? "",
  );
  return [...new Set(groups)].sort();
}

/** A choice of sessions for the silent errors: their positions, and the group each one takes. */
export interface Spread {
  readonly picks: readonly number[];
  readonly groups: readonly string[];
  readonly distinct: number;
}

/**
 * The silent errors' carriers, spread over confusable groups (spec WP7 step 1, as tightened): of
 * `count` sessions, each taking one of its own groups, the choice with the most distinct groups, so
 * no two errors share a group when the sessions allow it and as few do as possible when they
 * don't. Among equally spread choices, the earliest in the given order (sessions by position, then
 * groups in each one's order): the order is the seed's, so the seed breaks ties, never anything
 * else. Null when fewer than `count` sessions are given.
 */
export function bestSpread(options: readonly (readonly string[])[], count: number): Spread | null {
  if (count < 1 || options.length < count) return null;
  let best: Spread | null = null;
  const choose = (start: number, picks: number[]) => {
    if (picks.length === count) {
      const assign = (index: number, groups: string[]) => {
        if (index === picks.length) {
          const distinct = new Set(groups).size;
          if (best === null || distinct > best.distinct) {
            best = { picks: [...picks], groups: [...groups], distinct };
          }
          return;
        }
        for (const group of options[picks[index] as number] ?? []) {
          assign(index + 1, [...groups, group]);
        }
      };
      assign(0, []);
      return;
    }
    for (let next = start; next < options.length; next++) choose(next + 1, [...picks, next]);
  };
  choose(0, []);
  return best;
}

/**
 * The draw (spec WP7 step 1, as tightened): 4 snapped-name scripts, then the silent errors'
 * carriers first, 4 of the sessions that can carry one, then the other sessions filled from the
 * rest of the pool, accepted when the 10 hold 40 proposals and their carriers can spread over as
 * many confusable groups as the whole eligible pool allows. Few sessions can carry a silent error
 * once the open account is out on both sides, so a draw of all six at once would almost never hold
 * four of them; drawing the carriers first loosens no rule.
 */
function drawSessions(
  flaggedPool: readonly Analyzed[],
  restPool: readonly Analyzed[],
  widest: Spread,
): { flagged: Analyzed[]; rest: Analyzed[] } {
  const rng = createRng(subSeed(PILOT_SEED, "sessions"));
  const restCount = PILOT_SESSION_COUNT - PILOT_FLAGGED;
  const eligible = restPool.filter((item) => item.silent.length > 0);
  for (let draw = 0; draw < MAX_DRAWS; draw++) {
    const flagged = rng.shuffle(flaggedPool).slice(0, PILOT_FLAGGED);
    const carriers = rng.shuffle(eligible).slice(0, PILOT_SILENT);
    const fill = rng
      .shuffle(restPool.filter((item) => !carriers.includes(item)))
      .slice(0, restCount - PILOT_SILENT);
    const rest = [...carriers, ...fill];
    const total = [...flagged, ...rest].reduce((sum, item) => sum + item.slots.length, 0);
    if (total !== PILOT_PROPOSAL_COUNT) continue;
    const spread = bestSpread(
      rest.filter((item) => item.silent.length > 0).map(groupsOf),
      PILOT_SILENT,
    );
    if (spread === null || spread.distinct < widest.distinct) continue;
    return { flagged, rest };
  }
  throw new Error(
    `no draw of ${PILOT_FLAGGED} snapped-name scripts and ${restCount} others holds ${PILOT_PROPOSAL_COUNT} proposals with room for ${PILOT_SILENT} silent errors in ${widest.distinct} groups`,
  );
}

/**
 * A silent error for one carrier, in the confusable group its spread gave it (`groupId`): a seeded
 * pick of its candidates in that group, a sibling from the group outside the session's open
 * account, p from 0.88–0.93, the right record second at a lower p, then any of the link's own
 * candidates that stay below it.
 */
function silentSwap(item: Analyzed, rng: ReturnType<typeof createRng>, groupId: string): Swap {
  const slot = rng.pick(
    item.silent.filter(
      (candidate) => GROUP_OF.get(candidate.final.target.entityId ?? "")?.id === groupId,
    ),
  );
  const right = slot.final.target.entityId as string;
  const group = GROUP_OF.get(right);
  if (!group) throw new Error(`${item.script.id}: no confusable group for ${right}`);
  const shown = rng.pick(siblingsOf(right, item.script.focusEntityId ?? null));
  const [low, high] = SILENT_P_RANGE;
  const p = round(low + (high - low) * rng.next());
  const p2 = round((1 - p) * (0.5 + 0.4 * rng.next()));
  const others = slot.final.target.candidates.filter(
    (candidate) => candidate.entityId !== right && candidate.entityId !== shown && candidate.p < p2,
  );
  const candidates: TargetCandidate[] = [
    { entityId: shown, p },
    { entityId: right, p: p2 },
    ...others.map((candidate) => ({ ...candidate })),
  ].slice(0, MAX_CANDIDATES);
  return { slot, shown, p, group: group.id, candidates };
}

/** Six decimal places: enough for a probability, and the same on every machine. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** The silent error's proposal as the card receives it. */
function swapped(proposal: ProposalCreatedV2, swap: Swap): ProposalCreatedV2 {
  return {
    ...proposal,
    target: {
      ...proposal.target,
      decision: "linked",
      entityId: swap.shown,
      basis: "sound",
      p: swap.p,
      candidates: swap.candidates.map((candidate) => ({ ...candidate })),
    },
    riskFlags: [{ kind: "link_uncertain", field: "target" }],
  };
}

type Draft = Omit<EventEnvelope, "id" | "sessionId" | "seq">;

/** One session's events, as SessionDO writes them, with the run's own ids and the set's clocks. */
function sessionDrafts(run: ScriptRun, swaps: ReadonlyMap<string, Swap>): Draft[] {
  const { script } = run;
  const start = Date.parse(sessionContext(script).callTime);
  const at = (offsetMs: number) => new Date(start + offsetMs).toISOString();
  const drafts: Draft[] = [
    {
      type: "session.started",
      schemaVersion: 1,
      ts: at(0),
      payload: {
        mode: "debrief",
        engine: "cascaded",
        providers: {
          speechToText: { ...SPEECH_TO_TEXT },
          llm: { provider: PILOT_PROVIDER, model: LLM_MODELS[PILOT_PROVIDER] },
        },
        startedAt: at(0),
      },
    },
  ];
  let costUsd = 0;
  let lastEndMs = 0;
  for (const turn of run.turns) {
    const biased: UtteranceFinalV2 = turn.utterances.biased;
    const unbiased: UtteranceFinalV2 = turn.utterances.unbiased;
    if (!turn.completed) throw new Error(`${script.id}: a turn without turn.completed`);
    lastEndMs = biased.endMs;
    drafts.push({
      type: "utterance.final",
      schemaVersion: 2,
      ts: at(biased.endMs + 300),
      payload: { ...biased },
    });
    const done = at(biased.endMs + 1_500);
    for (const proposal of turn.biased) {
      const swap = swaps.get(proposal.proposalId);
      drafts.push({
        type: "proposal.created",
        schemaVersion: 2,
        ts: done,
        payload: (swap ? swapped(proposal, swap) : proposal) as unknown as Record<string, unknown>,
      });
    }
    if (turn.usage) {
      costUsd += turn.usage.costUsd;
      drafts.push({
        type: "usage.recorded",
        schemaVersion: 1,
        ts: done,
        payload: { ...turn.usage },
      });
    }
    drafts.push({
      type: "turn.completed",
      schemaVersion: 1,
      ts: done,
      payload: { ...turn.completed },
    });
    const witnessed = at(biased.endMs + 2_100);
    drafts.push({
      type: "utterance.final",
      schemaVersion: 2,
      ts: witnessed,
      payload: { ...unbiased },
    });
    for (const flagged of turn.flagged) {
      drafts.push({
        type: "proposal.flagged",
        schemaVersion: 1,
        ts: witnessed,
        payload: flagged as unknown as Record<string, unknown>,
      });
    }
    drafts.push({
      type: "turn.witnessed",
      schemaVersion: 1,
      ts: witnessed,
      payload: {
        turnId: turn.completed.turnId,
        outcome: "compared",
        provider: WITNESS.provider,
        model: WITNESS.model,
        utteranceIds: [unbiased.utteranceId],
        conflicts: turn.flagged.length,
        latencyMs: null,
        reason: null,
      },
    });
  }
  const endedAt = at(lastEndMs + 4_000);
  const sealedAt = new Date(Date.parse(endedAt) + SEAL_GRACE_MS).toISOString();
  drafts.push({
    type: "session.ended",
    schemaVersion: 1,
    ts: endedAt,
    payload: { endedAt, costUsd: round(costUsd) },
  });
  drafts.push({
    type: "session.sealed",
    schemaVersion: 1,
    ts: sealedAt,
    payload: { sealedAt, by: "session" },
  });
  return drafts;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The set's ids: UUIDv7-shaped, one block per session (`slot`), numbered in order of use. */
function pilotId(slot: number, n: number): string {
  return `01a1c6e9-${slot.toString(16).padStart(4, "0")}-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** Every UUID in a payload, in canonical key order (as `toJsonl` writes it). */
function uuidsIn(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    if (UUID.test(value)) into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) uuidsIn(item, into);
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) uuidsIn(record[key], into);
  }
}

function rewriteIds(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => rewriteIds(item, ids));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewriteIds(item, ids)]),
    );
  }
  return value;
}

/**
 * The session's events with the set's ids: the session `pilotId(slot, 0)`, then each event and
 * each id its payload names, numbered in the order the log first uses them. Returns the map too,
 * so the manifest can name the proposals by their new ids.
 */
function withSetIds(
  drafts: readonly Draft[],
  slot: number,
): { events: EventEnvelope[]; ids: Map<string, string> } {
  const sessionId = pilotId(slot, 0);
  const ids = new Map<string, string>();
  let next = 1;
  const events = drafts.map((draft, seq) => {
    const id = pilotId(slot, next++);
    const found: string[] = [];
    uuidsIn(draft.payload, found);
    for (const original of found) if (!ids.has(original)) ids.set(original, pilotId(slot, next++));
    return {
      id,
      sessionId,
      seq,
      type: draft.type,
      schemaVersion: draft.schemaVersion,
      ts: draft.ts,
      payload: rewriteIds(draft.payload, ids) as Record<string, unknown>,
    };
  });
  return { events, ids };
}

function tierWords(tier: Tier): string[] {
  return tier.reasons.map((reason) => `${reason.tier}:${reason.kind}@${reason.field ?? "-"}`);
}

function countTiers(proposals: readonly ProposalTier[]): TierCounts {
  const counts = { proposals: proposals.length, loud: 0, quiet: 0, nameNote: 0, none: 0 };
  for (const proposal of proposals) {
    if (proposal.tier === "loud") counts.loud++;
    else if (proposal.tier === "none") counts.none++;
    else if (proposal.reasons.some((reason) => reason.startsWith("quiet:"))) counts.quiet++;
    else counts.nameNote++;
  }
  return counts;
}

interface BuiltSession {
  readonly entry: ManifestSession;
  readonly text: string;
  readonly tiers: ProposalTier[];
  /** Original proposal id → the set's. */
  readonly ids: ReadonlyMap<string, string>;
}

async function buildSession(
  id: ManifestSession["id"],
  slot: number,
  item: Analyzed,
  swaps: ReadonlyMap<string, Swap>,
  seededKinds: ReadonlyMap<string, "flagged" | "silent">,
): Promise<BuiltSession> {
  const { events, ids } = withSetIds(sessionDrafts(item.run, swaps), slot);
  const text = toJsonl(events);
  // The log must read back and replay, as SessionDO's would.
  const projections = replay(fromJsonl(text), defaultProjections);
  if (projections.session?.sealedAt === null || projections.session === null) {
    throw new Error(`${item.script.id}: the log doesn't seal`);
  }
  const byNewId = new Map([...ids].map(([original, renamed]) => [renamed, original]));
  const tiers = projections.proposals.map((view): ProposalTier => {
    const tier = tierOf(view);
    const original = byNewId.get(view.proposalId) ?? "";
    return {
      session: id,
      proposalId: view.proposalId,
      type: view.type,
      tier: tier.tier,
      reasons: tierWords(tier),
      nameNote: tier.nameNote,
      seeded: seededKinds.get(original) ?? null,
    };
  });
  const context = sessionContext(item.script);
  return {
    entry: {
      id,
      script: item.script.id,
      file: `${id}.jsonl`,
      sha256: await sha256Hex(text),
      sessionId: events[0]?.sessionId ?? pilotId(slot, 0),
      focusEntityId: item.script.focusEntityId ?? null,
      callTime: context.callTime,
      timeZone: context.timeZone,
      proposals: projections.proposals.map((view) => view.proposalId),
    },
    text,
    tiers,
    ids,
  };
}

/** Runs the 200 on the Anthropic cassettes, draws the set, and writes its files. */
export async function buildPilotSet(inputs: PilotInputs): Promise<PilotSet> {
  const { labels } = inputs;
  const analyzed: Analyzed[] = [];
  let misses = 0;
  for (const script of inputs.scripts) {
    const cassette = inputs.cassettes.cassettes[script.id];
    if (!cassette) throw new Error(`no ${PILOT_PROVIDER} understanding cassette for ${script.id}`);
    // A fixed clock for the extractor's latency, so turn.completed's llmMs is the same every run.
    const run = await runScript(PILOT_PROVIDER, script, cassette, labels, { now: () => 0 });
    misses += run.turns.reduce((sum, turn) => sum + turn.misses, 0);
    analyzed.push(analyze(run, labels));
  }
  if (misses > 0) throw new Error(`the cassettes missed ${misses} requests: they're stale`);

  // The practice: a hand-written script with 3 proposals and no seeded error of any kind.
  const handWritten = new Set(DEBRIEF_FILES);
  const practicePool = analyzed.filter(
    (item) =>
      handWritten.has(item.script.id) &&
      item.slots.length === PILOT_PRACTICE_COUNT &&
      !item.labelled &&
      !item.wrongAccount &&
      !item.snapped,
  );
  if (practicePool.length === 0) throw new Error("no hand-written script fits the practice");
  const practice = createRng(subSeed(PILOT_SEED, "practice")).pick(practicePool);

  // The pools: the 48 snapped-name scripts carry the flagged errors; neither pool holds a wrong
  // account the set didn't seed.
  const flaggedPool = analyzed.filter(
    (item) =>
      item.snapped &&
      !item.wrongAccount &&
      item.slots.filter(isSnappedName).length === 1 &&
      item.flagged.length === 1,
  );
  const restPool = analyzed.filter(
    (item) => !item.snapped && !item.wrongAccount && item !== practice && item.slots.length > 0,
  );
  if (flaggedPool.length < PILOT_FLAGGED) {
    throw new Error(
      `only ${flaggedPool.length} snapped-name scripts carry a flagged error as written; ${PILOT_FLAGGED} are needed`,
    );
  }
  // The sessions that can carry a silent error, and the most confusable groups 4 of them allow.
  const eligible = restPool.filter((item) => item.silent.length > 0);
  const widest = bestSpread(eligible.map(groupsOf), PILOT_SILENT);
  if (widest === null) {
    throw new Error(
      `only ${eligible.length} sessions can carry a silent error as written; ${PILOT_SILENT} are needed`,
    );
  }
  const { flagged, rest } = drawSessions(flaggedPool, restPool, widest);

  // The silent errors: one each in 4 of the 6 other sessions that can carry one, in a seeded order,
  // spread over as many confusable groups as they allow (`bestSpread`).
  const silentRng = createRng(subSeed(PILOT_SEED, "silent"));
  const ordered = silentRng.shuffle(
    rest
      .filter((item) => item.silent.length > 0)
      .sort((a, b) => a.script.id.localeCompare(b.script.id)),
  );
  const spread = bestSpread(ordered.map(groupsOf), PILOT_SILENT);
  if (spread === null || spread.distinct < widest.distinct) {
    throw new Error("the draw left the silent errors fewer groups than the pool allows");
  }
  // Keyed by script and proposal: the runner numbers each script's proposals from 1.
  const key = (item: Analyzed, slot: Slot) => `${item.script.id}:${slot.final.proposalId}`;
  const swaps = new Map(
    spread.picks.map((position, index) => {
      const item = ordered[position] as Analyzed;
      const swap = silentSwap(item, silentRng, spread.groups[index] as string);
      return [key(item, swap.slot), swap] as const;
    }),
  );

  // Sessions s01 to s10, in script order.
  const chosen = [...flagged, ...rest].sort((a, b) => a.script.id.localeCompare(b.script.id));
  const seededKinds = new Map<string, "flagged" | "silent">();
  for (const item of flagged) seededKinds.set(key(item, item.flagged[0] as Slot), "flagged");
  for (const swapKey of swaps.keys()) seededKinds.set(swapKey, "silent");

  const sessionIds = chosen.map((_, index) => `s${String(index + 1).padStart(2, "0")}`);
  const built: BuiltSession[] = [];
  for (const [index, item] of chosen.entries()) {
    const own = (slot: Slot) => [slot.final.proposalId, key(item, slot)] as const;
    const sessionSwaps = new Map<string, Swap>();
    const sessionKinds = new Map<string, "flagged" | "silent">();
    for (const slot of item.slots) {
      const [proposalId, slotKey] = own(slot);
      const swap = swaps.get(slotKey);
      const kind = seededKinds.get(slotKey);
      if (swap) sessionSwaps.set(proposalId, swap);
      if (kind) sessionKinds.set(proposalId, kind);
    }
    built.push(
      await buildSession(
        sessionIds[index] as ManifestSession["id"],
        index + 1,
        item,
        sessionSwaps,
        sessionKinds,
      ),
    );
  }
  const practiceBuilt = await buildSession(
    "practice",
    PILOT_SESSION_COUNT + 1,
    practice,
    new Map(),
    new Map(),
  );

  // The seeded errors, with their right answers, in session order.
  const seeded: SeededError[] = [];
  for (const [index, item] of chosen.entries()) {
    const session = sessionIds[index] as string;
    const ids = built[index]?.ids ?? new Map<string, string>();
    for (const slot of item.slots) {
      const kind = seededKinds.get(key(item, slot));
      if (!kind) continue;
      const common = {
        session,
        proposalId: ids.get(slot.final.proposalId) ?? "",
        script: item.script.id,
        turn: slot.turn,
        index: slot.index,
      };
      if (kind === "flagged") {
        seeded.push({
          kind,
          ...common,
          snapped: slot.final.target.candidates[0]?.entityId ?? "",
          candidates: slot.final.target.candidates.map((candidate) => ({ ...candidate })),
          right: { entityId: null },
        });
      } else {
        const swap = swaps.get(key(item, slot)) as Swap;
        seeded.push({
          kind,
          ...common,
          shown: swap.shown,
          p: swap.p,
          group: swap.group,
          candidates: swap.candidates.map((candidate) => ({ ...candidate })),
          right: { entityId: slot.final.target.entityId ?? "" },
        });
      }
    }
  }

  const proposals = built.flatMap((session) => session.tiers);
  const openAccounts = new Map(
    built.map((session) => [session.entry.id, session.entry.focusEntityId]),
  );
  checkSet(proposals, practiceBuilt.tiers, seeded, openAccounts);

  const rows = balancedLatinRectangle(
    sessionIds,
    PILOT_PARTICIPANTS.length,
    createRng(subSeed(PILOT_SEED, "orders")),
  );
  const orders = Object.fromEntries([
    ...PILOT_PARTICIPANTS.map((participant, index) => [participant, rows[index] ?? []]),
    [CI_PARTICIPANT, [...sessionIds]],
  ]) as PilotManifest["orders"];

  const body = {
    format: 1 as const,
    set: PILOT_SET,
    seed: PILOT_SEED,
    source: {
      provider: PILOT_PROVIDER,
      linker: LINKER_PARAMS_V1.version,
      ...inputs.hashes,
    },
    sessions: built.map((session) => session.entry),
    practice: practiceBuilt.entry,
    seeded,
    orders,
    tiers: {
      all: countTiers(proposals),
      seeded: countTiers(proposals.filter((proposal) => proposal.seeded !== null)),
      other: countTiers(proposals.filter((proposal) => proposal.seeded === null)),
      practice: countTiers(practiceBuilt.tiers),
      proposals: [...proposals, ...practiceBuilt.tiers],
    },
  };
  const sha256 = await setSha256(body);
  const { format, set, ...rest2 } = body;
  const manifest = PilotManifestSchema.parse({ format, set, sha256, ...rest2 });

  const files = new Map<string, string>();
  for (const session of built) files.set(session.entry.file, session.text);
  files.set(practiceBuilt.entry.file, practiceBuilt.text);
  files.set("manifest.json", manifestText(manifest));
  return {
    files,
    manifest,
    silentPool: {
      sessions: eligible.map((item) => ({ script: item.script.id, groups: groupsOf(item) })),
      widest: widest.distinct,
    },
  };
}

/**
 * The set as the spec writes it, or an error: 40 proposals, 4 flagged errors that `tierOf` makes
 * loud, 4 silent ones with the name note and nothing louder, neither of whose records (the one
 * named, the one shown) is its session's open account or belongs to it, and a practice with none.
 */
function checkSet(
  proposals: readonly ProposalTier[],
  practice: readonly ProposalTier[],
  seeded: readonly SeededError[],
  openAccounts: ReadonlyMap<string, string | null>,
): void {
  const problems: string[] = [];
  if (proposals.length !== PILOT_PROPOSAL_COUNT) {
    problems.push(`${proposals.length} proposals, not ${PILOT_PROPOSAL_COUNT}`);
  }
  if (practice.length !== PILOT_PRACTICE_COUNT) {
    problems.push(`a practice of ${practice.length}, not ${PILOT_PRACTICE_COUNT}`);
  }
  const byId = new Map(proposals.map((proposal) => [proposal.proposalId, proposal]));
  const count = (kind: SeededError["kind"]) => seeded.filter((error) => error.kind === kind).length;
  if (count("flagged") !== PILOT_FLAGGED) problems.push(`${count("flagged")} flagged errors`);
  if (count("silent") !== PILOT_SILENT) problems.push(`${count("silent")} silent errors`);
  for (const error of seeded) {
    const tier = byId.get(error.proposalId);
    if (!tier) {
      problems.push(`seeded ${error.proposalId} isn't in the set`);
    } else if (error.kind === "flagged" && tier.tier !== "loud") {
      problems.push(`flagged ${error.proposalId} is ${tier.tier}, not loud`);
    } else if (
      error.kind === "silent" &&
      (tier.tier !== "quiet" || tier.nameNote !== "sound" || tier.reasons.length > 0)
    ) {
      problems.push(`silent ${error.proposalId} isn't the name note alone (${tier.tier})`);
    }
    if (error.kind === "silent" && error.candidates[1]?.entityId !== error.right.entityId) {
      problems.push(`silent ${error.proposalId}'s right record isn't second`);
    }
    if (error.kind === "silent") {
      const openAccount = openAccounts.get(error.session) ?? null;
      if (
        inOpenAccount(error.shown, openAccount) ||
        inOpenAccount(error.right.entityId, openAccount)
      ) {
        problems.push(`silent ${error.proposalId} touches its session's open account`);
      }
    }
  }
  if (problems.length > 0)
    throw new Error(`pilot.v1 isn't as written:\n- ${problems.join("\n- ")}`);
}
