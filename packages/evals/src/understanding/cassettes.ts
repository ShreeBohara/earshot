// The understanding eval's cassettes (Phase 4 WP10 step 5; ADR-0031): all 200 scripts, both LLM
// adapters, built offline from the ground truth, as the e2e cassettes are (src/generate.ts), but
// with seeded, labelled "model-like" errors in the drafts:
//
// - 5% of date fields (due dates, close dates, meeting days) carry a wrong date, with the right
//   words quoted;
// - 3% of amounts carry a wrong figure, with the right words quoted;
// - 3% of named targets quote the record's name in words the transcript doesn't hold (a
//   paraphrase), the way a model that "corrects" a name, or adds to it, would.
//
// Each error is chosen by a seeded shuffle, so the counts are exact, and labelled in
// cassettes/understanding/errors.json; the report measures the normalizers' catches against the
// labels. Each turn's request carries what the production stream heard (`heard.biased`). Nothing
// here makes a network request; scripts/gen-cassettes.ts writes the files and a test regenerates
// them.
import type { ToolProposal } from "@earshot/agent";
import { LLM_MODELS } from "@earshot/agent";
import {
  CASSETTE_VERSION,
  type Cassette,
  type CassetteFile,
  recordScenario,
  type Scenario,
} from "@earshot/agent/testing";
import type { LlmProvider, UtteranceFinalV2 } from "@earshot/core";
import { z } from "zod";
import { createRng, subSeed } from "../channel/rng";
import { EVAL_PROVIDERS, evalResponse, evalSession, evalTurnId, toolProposal } from "../generate";
import { type DebriefScript, namedOf } from "../schema";
import { sessionContext, turnTranscript } from "../session";

/** The errors' seed: SHA-256's seventh initial hash word. */
export const ERROR_SEED = 0x1f83d9ab;
export const ERROR_RATES = {
  wrong_date: 0.05,
  wrong_amount: 0.03,
  paraphrased_target: 0.03,
} as const;
export const ERROR_KINDS = ["wrong_date", "wrong_amount", "paraphrased_target"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];
export const ERRORS_VERSION = 1;

const DATE_FIELDS = ["dueDate", "closeDate", "date"] as const;

export const SeededError = z.strictObject({
  script: z.string().regex(/^d\d{3}$/),
  /** 0-based, as the scripts' arrays index them. */
  turn: z.int().nonnegative(),
  proposal: z.int().nonnegative(),
  kind: z.enum(ERROR_KINDS),
  /** The field (`target` for a paraphrased target). */
  field: z.string().min(1),
  /** The ground truth: the value, or the target's words as heard. */
  truth: z.union([z.string(), z.number()]),
  /** What the cassette's model wrote instead. */
  wrote: z.union([z.string(), z.number()]),
});
export type SeededError = z.infer<typeof SeededError>;

export const ErrorLabels = z.strictObject({
  version: z.literal(ERRORS_VERSION),
  seed: z.int(),
  rates: z.strictObject({
    wrong_date: z.number(),
    wrong_amount: z.number(),
    paraphrased_target: z.number(),
  }),
  /** How many fields or targets each kind was drawn from. */
  eligible: z.strictObject({
    wrong_date: z.int().nonnegative(),
    wrong_amount: z.int().nonnegative(),
    paraphrased_target: z.int().nonnegative(),
  }),
  errors: z.array(SeededError),
});
export type ErrorLabels = z.infer<typeof ErrorLabels>;

interface Site {
  readonly script: string;
  readonly turn: number;
  readonly proposal: number;
  readonly field: string;
}

const DAY_MS = 86_400_000;

function shiftDate(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Words a quote search would match: letters and digits, lowercased, in order. */
function wordKeys(text: string): string[] {
  return text
    .toLowerCase()
    .split(" ")
    .map((word) => [...word].filter((char) => /[\p{L}\p{N}]/u.test(char)).join(""))
    .filter((word) => word !== "");
}

/** Whether `quote`'s words occur in `text` in a row, as @earshot/agent's locator would find them. */
function wordsOccur(text: string, quote: string): boolean {
  const haystack = wordKeys(text);
  const needle = wordKeys(quote);
  if (needle.length === 0) return true;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((word, j) => haystack[i + j] === word)) return true;
  }
  return false;
}

/** The paraphrases a model writes for a record's name: more words than the rep said. */
const PARAPHRASES = [
  (q: string) => `the ${q} account`,
  (q: string) => `${q} team`,
  (q: string) => `the folks at ${q}`,
  (q: string) => `${q} Incorporated`,
] as const;

/** Chooses each kind's sites by a seeded shuffle and writes each one's wrong value. */
export function seedErrors(scripts: readonly DebriefScript[]): ErrorLabels {
  const dates: Site[] = [];
  const amounts: Site[] = [];
  const targets: Site[] = [];
  for (const script of scripts) {
    script.turns.forEach((turn, turnIndex) => {
      turn.expect.forEach((proposal, proposalIndex) => {
        const site = { script: script.id, turn: turnIndex, proposal: proposalIndex };
        const fields = proposal.fields as Readonly<Record<string, unknown>>;
        for (const field of DATE_FIELDS)
          if (fields[field] !== undefined) dates.push({ ...site, field });
        if (fields.amount !== undefined) amounts.push({ ...site, field: "amount" });
        if (proposal.type !== "contact" && namedOf(proposal) !== null) {
          targets.push({ ...site, field: "target" });
        }
      });
    });
  }
  const byId = new Map(scripts.map((script) => [script.id, script]));
  const proposalAt = (site: Site) => {
    const proposal = byId.get(site.script)?.turns[site.turn]?.expect[site.proposal];
    if (!proposal) throw new Error(`no proposal at ${site.script} ${site.turn} ${site.proposal}`);
    return proposal;
  };
  const choose = (kind: ErrorKind, sites: readonly Site[]): Site[] => {
    const rng = createRng(subSeed(ERROR_SEED, kind));
    const count = Math.round(ERROR_RATES[kind] * sites.length);
    const order = (site: Site) =>
      `${site.script}:${String(site.turn).padStart(2, "0")}:${site.proposal}:${site.field}`;
    return rng
      .shuffle(sites)
      .slice(0, count)
      .sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  };
  const rng = createRng(subSeed(ERROR_SEED, "values"));
  const errors: SeededError[] = [];
  for (const site of choose("wrong_date", dates)) {
    const truth =
      (proposalAt(site).fields as Record<string, { value: string }>)[site.field]?.value ?? "";
    errors.push({
      ...site,
      kind: "wrong_date",
      truth,
      wrote: shiftDate(truth, rng.pick([-7, -2, -1, 1, 2, 7])),
    });
  }
  for (const site of choose("wrong_amount", amounts)) {
    const truth = (proposalAt(site).fields as Record<string, { value: number }>).amount?.value ?? 0;
    const options = [
      truth * 10,
      truth + 1_000,
      truth + 10_000,
      Math.max(1_000, truth - 5_000),
    ].filter((value) => value !== truth && value > 0);
    if (truth % 10 === 0) options.push(truth / 10);
    errors.push({ ...site, kind: "wrong_amount", truth, wrote: rng.pick(options) });
  }
  for (const site of choose("paraphrased_target", targets)) {
    const proposal = proposalAt(site);
    const turn = byId.get(site.script)?.turns[site.turn];
    const quote = namedOf(proposal)?.quote ?? "";
    const options = PARAPHRASES.map((write) => write(quote)).filter(
      (written) => !wordsOccur(turn?.heard.biased ?? "", written),
    );
    if (options.length === 0) throw new Error(`no paraphrase of "${quote}" leaves the transcript`);
    errors.push({ ...site, kind: "paraphrased_target", truth: quote, wrote: rng.pick(options) });
  }
  return {
    version: ERRORS_VERSION,
    seed: ERROR_SEED,
    rates: { ...ERROR_RATES },
    eligible: {
      wrong_date: dates.length,
      wrong_amount: amounts.length,
      paraphrased_target: targets.length,
    },
    errors,
  };
}

/** The errors seeded into one turn. */
export function errorsAt(labels: ErrorLabels, script: string, turn: number): SeededError[] {
  return labels.errors.filter((error) => error.script === script && error.turn === turn);
}

/** A turn's drafts as the cassette's model writes them: the ground truth, with its seeded errors. */
export function understandingDrafts(
  script: DebriefScript,
  turnIndex: number,
  labels: ErrorLabels,
): ToolProposal[] {
  const turn = script.turns[turnIndex];
  if (!turn) throw new RangeError(`${script.id} has no turn ${turnIndex + 1}`);
  const errors = errorsAt(labels, script.id, turnIndex);
  return turn.expect.map((expected, index) => {
    const draft = structuredClone(toolProposal(expected));
    for (const error of errors.filter((candidate) => candidate.proposal === index)) {
      if (error.kind === "paraphrased_target") {
        if (!("target" in draft) || draft.target === null)
          throw new Error(`no target to paraphrase`);
        draft.target = { ...draft.target, quote: String(error.wrote) };
        continue;
      }
      const fields = draft.fields as Record<
        string,
        { value: string | number; quote: string } | null
      >;
      const field = fields[error.field];
      if (!field) throw new Error(`${script.id}: no ${error.field} to get wrong`);
      fields[error.field] = { ...field, value: error.wrote };
    }
    return draft;
  });
}

/** A UUIDv7-shaped id for the understanding eval's utterances (kind 3 biased, 4 unbiased). */
function utteranceId(script: DebriefScript, turnIndex: number, kind: number): string {
  const n = Number(script.id.slice(1));
  const tail = `${kind}${n.toString(16).padStart(5, "0")}${(turnIndex + 1).toString(16).padStart(6, "0")}`;
  return `01a1c6e5-0000-7000-8000-${tail}`;
}

/**
 * A turn's two transcripts as the session receives them: the production stream's final
 * (`heard.biased`) and the second witness's (`heard.unbiased`), one utterance each over the same
 * window, with no word timings, so the comparison reads the unbiased words by alignment.
 */
export function understandingUtterances(
  script: DebriefScript,
  turnIndex: number,
): { readonly biased: UtteranceFinalV2; readonly unbiased: UtteranceFinalV2 } {
  const turn = script.turns[turnIndex];
  if (!turn) throw new RangeError(`${script.id} has no turn ${turnIndex + 1}`);
  const startMs = turnIndex * 15_000;
  const endMs = startMs + Math.max(1, turn.text.split(" ").length) * 400;
  return {
    biased: {
      utteranceId: utteranceId(script, turnIndex, 3),
      text: turnTranscript({ text: turn.heard.biased }),
      confidence: 0.95,
      startMs,
      endMs,
      witness: "biased",
    },
    unbiased: {
      utteranceId: utteranceId(script, turnIndex, 4),
      text: turnTranscript({ text: turn.heard.unbiased }),
      confidence: 0.9,
      startMs,
      endMs,
      witness: "unbiased",
    },
  };
}

/** One turn as a recordable scenario: what the stream heard, and the drafts with their errors. */
function understandingScenario(
  provider: LlmProvider,
  script: DebriefScript,
  turnIndex: number,
  labels: ErrorLabels,
): Scenario {
  const drafts = understandingDrafts(script, turnIndex, labels);
  const context = sessionContext(script);
  const { biased } = understandingUtterances(script, turnIndex);
  return {
    name: `${script.id}-turn-${turnIndex + 1}`,
    description: `${script.id}, turn ${turnIndex + 1}: "${biased.text}"`,
    provider,
    turn: {
      turnId: evalTurnId(script, turnIndex),
      utterances: [biased],
      session: evalSession(script),
      callTime: context.callTime,
      timeZone: context.timeZone,
    },
    responses: [evalResponse(provider, script, turnIndex, drafts)],
    expect: { outcome: drafts.length > 0 ? "proposals" : "nothing_to_propose", attempts: 1 },
  };
}

/** Every provider's understanding cassettes: one cassette per script, one interaction per turn. */
export async function generateUnderstandingCassettes(
  scripts: readonly DebriefScript[],
  labels: ErrorLabels,
): Promise<Record<LlmProvider, CassetteFile>> {
  const build = async (provider: LlmProvider): Promise<CassetteFile> => {
    const cassettes: Record<string, Cassette> = {};
    for (const script of scripts) {
      const interactions = [];
      for (let index = 0; index < script.turns.length; index++) {
        const recorded = await recordScenario(
          understandingScenario(provider, script, index, labels),
        );
        interactions.push(...recorded.interactions);
      }
      cassettes[script.id] = { name: script.id, description: script.title, interactions };
    }
    return {
      version: CASSETTE_VERSION,
      provider,
      model: LLM_MODELS[provider],
      source: "hand-made",
      cassettes,
    };
  };
  const files = {} as Record<LlmProvider, CassetteFile>;
  for (const provider of EVAL_PROVIDERS) files[provider] = await build(provider);
  return files;
}

/**
 * A cassette file's bytes: the header, then one script's cassette per line, so a diff shows which
 * scripts changed without the 4 MB a pretty-printed file would take.
 */
export function serializeCassetteFile(file: CassetteFile): string {
  const { cassettes, ...header } = file;
  const head = JSON.stringify(header).slice(0, -1);
  const lines = Object.entries(cassettes).map(
    ([id, cassette]) => `${JSON.stringify(id)}:${JSON.stringify(cassette)}`,
  );
  return `${head},"cassettes":{\n${lines.join(",\n")}\n}}\n`;
}

/** The labels file's bytes: two-space JSON, one error per line inside it. */
export function serializeErrorLabels(labels: ErrorLabels): string {
  const { errors, ...header } = labels;
  const head = JSON.stringify(header, null, 2).slice(0, -2);
  const lines = errors.map((error) => `    ${JSON.stringify(error)}`);
  return `${head},\n  "errors": [\n${lines.join(",\n")}\n  ]\n}\n`;
}
