// The KLM estimate per card (Phase 5 spec §4.8, WP8, gate G1a; P5 §3; ADR-0039): how long the
// Keystroke-Level Model says a pilot card takes, from the words it shows and the keys its decision
// needs. KLM's error is about 21%, so this guards against regressions; it isn't a measurement.
// Pure: the scripted reviewer (apps/web/e2e/pilot/scripted-reviewer.spec.ts) measures each card in
// the page and spends its estimate on the page's fake clock, and the tests run it on hand-made
// cards.
//
// - **A card's estimate:** M + words ÷ rate + K × keys, where M is 1.35 s (mental preparation), K
//   is 0.28 s (a keystroke by a non-secretary), and the rate is 3.97 words a second on a loud card
//   (reading at 238 words a minute) and 7.93 on any other (scanning at twice that, an assumption).
// - **Words** are what the card shows a reviewer: the words of its visible text when the key that
//   decides it is pressed, so a fix in the correction panel counts the open panel's words too. Text
//   that isn't on screen (hidden, or visually hidden for screen readers) doesn't count, and neither
//   do the card's buttons and key labels: keys pay for those. A word is a run of characters
//   between whitespace with at least one letter or digit, so "·", "→", and a lone quotation mark
//   aren't words, and "$112,000", "2:30", and an email address are one each (`countWords`).
// - **The gate:** the median card at most 4.0 s, and no card more than 10% above its baseline
//   (`baselines/pilot-klm.json`; targets). While the committed set's median misses 4.0 s, the
//   median may not rise above the baseline's either (`checkKlm`).
// - **The baseline** is recorded on purpose, from the committed set, by the scripted reviewer:
//   `CI=1 EARSHOT_PILOT_KLM=record pnpm --filter @earshot/web exec playwright test
//   e2e/pilot/scripted-reviewer.spec.ts`. Review the diff, then commit it.
import { z } from "zod";
import { PILOT_PROPOSAL_COUNT, PILOT_SET, type PilotManifest, PilotSessionId } from "./set";
import { median } from "./stats";

/** KLM's operators (Card, Moran, and Newell 1980) and the reading rates (Brysbaert 2019). */
export const KLM = {
  /** M: mental preparation, once a card. */
  mentalS: 1.35,
  /** K: one keystroke by a non-secretary. */
  keyS: 0.28,
  /** Reading, on a loud card: 238 words a minute. */
  readWps: 3.97,
  /** Scanning, on any other card: twice reading speed (an assumption). */
  scanWps: 7.93,
} as const;

/** K in whole milliseconds, as the fake clock spends it. */
export const KLM_KEY_MS = Math.round(KLM.keyS * 1000);

/** The gate's target for the median card (spec §6, G1a). */
export const KLM_MEDIAN_TARGET_MS = 4_000;

/** How far above its baseline a card's estimate may go (spec WP8; target). */
export const KLM_REGRESSION = 0.1;

/** Where the scripted reviewer records the baseline, from the repository's root. */
export const KLM_BASELINE_PATH = "packages/evals/baselines/pilot-klm.json";

/** The command that records it. */
export const KLM_RECORD_COMMAND =
  "CI=1 EARSHOT_PILOT_KLM=record pnpm --filter @earshot/web exec playwright test e2e/pilot/scripted-reviewer.spec.ts";

const SPACE = /\s/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * The words in `text`: runs of characters between whitespace with at least one letter or digit.
 * One pass over the characters, each tested alone, so no input can make it backtrack.
 */
export function countWords(text: string): number {
  let words = 0;
  let inRun = false;
  let counted = false;
  for (const char of text) {
    if (SPACE.test(char)) {
      inRun = false;
      continue;
    }
    if (!inRun) {
      inRun = true;
      counted = false;
    }
    if (!counted && LETTER_OR_DIGIT.test(char)) {
      words += 1;
      counted = true;
    }
  }
  return words;
}

/** What the estimate reads from a card. */
export interface KlmInput {
  /** Whether the card is loud: then it's read, not scanned. */
  readonly loud: boolean;
  /** The words it shows when its deciding key is pressed. */
  readonly words: number;
  /** The keys its decision takes. */
  readonly keys: number;
}

function rate(loud: boolean): number {
  return loud ? KLM.readWps : KLM.scanWps;
}

/** A card's estimate in seconds: M + words ÷ rate + K × keys. */
export function klmSeconds({ loud, words, keys }: KlmInput): number {
  return KLM.mentalS + words / rate(loud) + KLM.keyS * keys;
}

/** The reading part (M and the words) of an estimate, in whole milliseconds. */
function readingMs(loud: boolean, words: number): number {
  return Math.round(1000 * (KLM.mentalS + words / rate(loud)));
}

/** A card's estimate in whole milliseconds: the reading rounded once, plus K a key. */
export function klmMs(input: KlmInput): number {
  return readingMs(input.loud, input.words) + KLM_KEY_MS * input.keys;
}

/**
 * How the scripted reviewer spends a card's estimate on the page's fake clock, one step before each
 * key: the reading of the words shown since the last step (M with the first), then K. `words[i]` is
 * what the card shows just before key i, which may only grow (a key that opens a panel adds its
 * words). The steps add up to `klmMs` of the last count, to the millisecond.
 */
export function klmSteps(loud: boolean, words: readonly number[]): number[] {
  let read = 0;
  let shown = 0;
  return words.map((count) => {
    if (count < shown) {
      throw new RangeError(
        `a card's words may only grow before its decision, not ${shown} → ${count}`,
      );
    }
    shown = count;
    const through = readingMs(loud, count);
    const step = through - read + KLM_KEY_MS;
    read = through;
    return step;
  });
}

// ─── The baseline ─────────────────────────────────────────────────────────────────────────────────

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * What a decision does: accept a card as it stands, reject it, choose in a question (a loud card's
 * numbered records), or choose another record for a linked card (c, then its number).
 */
export const DecisionKind = z.enum(["accept", "reject", "question", "another_record"]);
export type DecisionKind = z.infer<typeof DecisionKind>;

/** One card of the 40, as the scripted reviewer measured it. */
export const KlmCard = z.strictObject({
  session: PilotSessionId,
  proposalId: z.uuid(),
  /** Its heading as shown: the type and the record, with any name note. */
  heading: z.string().min(1),
  /** The card's tier, as the manifest builds it and the page showed it. */
  tier: z.enum(["loud", "quiet", "none"]),
  seeded: z.enum(["flagged", "silent"]).nullable(),
  decision: DecisionKind,
  /** The keys the decision took, in order. */
  keys: z.array(z.string().min(1)).min(1),
  words: z.int().nonnegative(),
  /** The estimate, in whole milliseconds (`klmMs`). */
  ms: z.int().positive(),
});
export type KlmCard = z.infer<typeof KlmCard>;

/** `baselines/pilot-klm.json`: the 40 cards' estimates on the committed set, recorded on purpose. */
export const KlmBaseline = z.strictObject({
  format: z.literal(1),
  set: z.literal(PILOT_SET),
  setSha256: Hex64,
  recordedAt: z.iso.date(),
  /** The model the estimates were taken with; another model needs another baseline. */
  model: z.strictObject({
    mentalS: z.number(),
    keyS: z.number(),
    readWps: z.number(),
    scanWps: z.number(),
  }),
  medianMs: z.number().positive(),
  cards: z.array(KlmCard).length(PILOT_PROPOSAL_COUNT),
});
export type KlmBaseline = z.infer<typeof KlmBaseline>;

/** The median of the cards' estimates, in ms (the mean of the middle two for an even count). */
export function klmMedianMs(cards: readonly Pick<KlmCard, "ms">[]): number {
  return median(cards.map((card) => card.ms)) ?? 0;
}

/** A baseline from a run's 40 cards, as the scripted reviewer records it. */
export function klmBaseline(
  cards: readonly KlmCard[],
  manifest: Pick<PilotManifest, "set" | "sha256">,
  recordedAt: string,
): KlmBaseline {
  return KlmBaseline.parse({
    format: 1,
    set: manifest.set,
    setSha256: manifest.sha256,
    recordedAt,
    model: { ...KLM },
    medianMs: klmMedianMs(cards),
    cards,
  });
}

/** The baseline's text as written: two-space JSON and a final newline. */
export function klmBaselineText(baseline: KlmBaseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

/** What the gate found. */
export interface KlmCheck {
  readonly medianMs: number;
  readonly max: KlmCard | null;
  /** Whether the median meets the spec's 4.0 s. */
  readonly targetMet: boolean;
  /** What the median is held to: 4.0 s, or the baseline's median while the set misses that. */
  readonly ceilingMs: number;
  /** Each card against its baseline: its estimate there, or null when it has none. */
  readonly against: ReadonlyMap<string, number | null>;
  /** Everything that fails the gate, one line each; empty when it passes. */
  readonly problems: readonly string[];
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * The gate (spec WP8, G1a): no card more than 10% above its baseline, and the median at most
 * 4.0 s, or, while the committed set misses that, at most the baseline's median. A baseline from
 * another set or model, a card it doesn't hold, and a card it holds that the run didn't review
 * fail too: each means it's time to re-record it, on purpose.
 */
export function checkKlm(
  cards: readonly KlmCard[],
  baseline: KlmBaseline | null,
  manifest: Pick<PilotManifest, "sha256">,
): KlmCheck {
  const problems: string[] = [];
  const medianMs = klmMedianMs(cards);
  const max = cards.reduce<KlmCard | null>(
    (top, card) => (!top || card.ms > top.ms ? card : top),
    null,
  );
  const record = `re-record it on purpose (${KLM_RECORD_COMMAND}) and review the diff`;
  let usable = baseline;
  if (baseline === null) {
    problems.push(`No ${KLM_BASELINE_PATH}: record one on purpose (${KLM_RECORD_COMMAND}).`);
  } else if (baseline.setSha256 !== manifest.sha256) {
    problems.push(`${KLM_BASELINE_PATH} was recorded on another set: ${record}.`);
    usable = null;
  } else if (
    baseline.model.mentalS !== KLM.mentalS ||
    baseline.model.keyS !== KLM.keyS ||
    baseline.model.readWps !== KLM.readWps ||
    baseline.model.scanWps !== KLM.scanWps
  ) {
    problems.push(`${KLM_BASELINE_PATH} was recorded with another model: ${record}.`);
    usable = null;
  }
  const against = new Map<string, number | null>();
  if (usable) {
    const before = new Map(usable.cards.map((card) => [card.proposalId, card]));
    for (const card of cards) {
      const was = before.get(card.proposalId);
      against.set(card.proposalId, was?.ms ?? null);
      if (!was) {
        problems.push(
          `${card.session} ${card.proposalId}: not in ${KLM_BASELINE_PATH}; ${record}.`,
        );
        continue;
      }
      if (card.ms > was.ms * (1 + KLM_REGRESSION)) {
        problems.push(
          `${card.session} ${card.proposalId}: ${seconds(card.ms)}, more than ${100 * KLM_REGRESSION}% above its baseline ${seconds(was.ms)} (words ${was.words} → ${card.words}, keys ${was.keys.join(" ")} → ${card.keys.join(" ")}).`,
        );
      }
      if (card.tier !== was.tier) {
        problems.push(
          `${card.session} ${card.proposalId}: ${card.tier}, ${was.tier} in its baseline; ${record}.`,
        );
      }
    }
    const reviewed = new Set(cards.map((card) => card.proposalId));
    for (const was of usable.cards) {
      if (!reviewed.has(was.proposalId)) {
        problems.push(
          `${was.session} ${was.proposalId}: in ${KLM_BASELINE_PATH}, but not reviewed.`,
        );
      }
    }
  }
  const targetMet = medianMs <= KLM_MEDIAN_TARGET_MS;
  const ceilingMs = Math.max(KLM_MEDIAN_TARGET_MS, usable?.medianMs ?? KLM_MEDIAN_TARGET_MS);
  if (medianMs > ceilingMs) {
    problems.push(
      ceilingMs === KLM_MEDIAN_TARGET_MS
        ? `The median card's estimate is ${seconds(medianMs)}, over the ${seconds(KLM_MEDIAN_TARGET_MS)} target.`
        : `The median card's estimate is ${seconds(medianMs)}, over its baseline's ${seconds(ceilingMs)}: while the set misses the ${seconds(KLM_MEDIAN_TARGET_MS)} target, the median may not rise.`,
    );
  }
  return { medianMs, max, targetMet, ceilingMs, against, problems };
}
