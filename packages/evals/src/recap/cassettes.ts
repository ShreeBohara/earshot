// The recap eval's cassettes (Phase 5 WP10 step 5; ADR-0037): one recap per debrief, all 200, on
// both LLM adapters, built offline from the ground truth, the way the understanding cassettes are,
// with seeded, labelled bad sentences the checks must drop.
//
// What the cassette's model writes for a script:
// - a headline: the first note's body, quoting its words (and the words that named its record),
//   or, in a debrief without a note, its first proposal's main field;
// - a next step per task: its title, and its due date's words when it has one;
// - a commitment per commitment: its text, and who it's to and when, when said;
// - for three debriefs in four, a methodology lens (MEDDIC, SPICED, BANT in turn): each field the
//   ground truth can answer quotes the words it came from (an amount for a budget, a stage for a
//   decision process, a note for a pain), and the rest are null.
//
// Seeded errors, each chosen by a seeded shuffle so the counts are exact, and labelled in
// cassettes/recap/seeded.json:
// - 10% of the ground truth's sentences (target) get a bad twin right after them: the same
//   sentence with its quotes paraphrased, or an invented sentence with an invented quote. Neither
//   is in the transcript (the generator checks with `locateQuote` itself), so the checks must drop
//   every one;
// - 10% of the lens fields the ground truth leaves unanswered get an invented quote, which must
//   come back "not mentioned".
//
// Every request carries what the production stream heard (`heard.biased`), turn by turn, as the
// understanding eval's utterances do. Nothing here makes a network request:
// scripts/gen-recap-cassettes.ts writes the files, and a test regenerates them.
import { LLM_MODELS, locateQuote, type RecapProposal } from "@earshot/agent";
import { SUBMIT_RECAP_JSON_SCHEMA, type SubmitRecapInput } from "@earshot/agent/recap";
import {
  CASSETTE_VERSION,
  type Cassette,
  type CassetteFile,
  type RecapScenario,
  recapResponse,
  recordRecap,
} from "@earshot/agent/testing";
import type { LlmProvider, RecapLensId, UtteranceFinalV2 } from "@earshot/core";
import { z } from "zod";
import { createRng, subSeed } from "../channel/rng";
import { EVAL_PROVIDERS } from "../generate";
import type { DebriefScript, ExpectedField, ExpectedProposal } from "../schema";
import { demoEntity } from "../session";
import { understandingUtterances } from "../understanding/cassettes";

/** The recap's seed: SHA-256's eighth initial hash word. */
export const RECAP_SEED = 0x5be0cd19;
/** The share of ground-truth sentences that get a bad twin, and of unanswered lens fields that get an invented quote (targets). */
export const RECAP_ERROR_RATES = { bad_sentence: 0.1, bad_lens_quote: 0.1 } as const;
export const RECAP_LABELS_VERSION = 1;
/** Which lens a script's recap maps, by its number: none, then MEDDIC, SPICED, and BANT. */
export const RECAP_LENS_ROTATION: readonly (RecapLensId | null)[] = [
  null,
  "meddic",
  "spiced",
  "bant",
];

export const BAD_SENTENCE_KINDS = ["paraphrased", "invented"] as const;
export type BadSentenceKind = (typeof BAD_SENTENCE_KINDS)[number];

export const BadSentence = z.strictObject({
  script: z.string().regex(/^d\d{3}$/),
  /** Its position in the cassette's sentences, 0-based. */
  index: z.int().nonnegative(),
  /** How it's bad: its quotes paraphrase the rep's words, or it's invented outright. */
  error: z.enum(BAD_SENTENCE_KINDS),
  /** The kind of sentence it passes for: its ground-truth neighbour's. */
  kind: z.enum(["headline", "next_step", "commitment"]),
  /** The position of the ground-truth sentence it follows. */
  after: z.int().nonnegative(),
  text: z.string().min(1),
  quotes: z.array(z.string().min(1)).min(1).max(4),
});
export type BadSentence = z.infer<typeof BadSentence>;

export const BadLensQuote = z.strictObject({
  script: z.string().regex(/^d\d{3}$/),
  lens: z.enum(["meddic", "spiced", "bant"]),
  field: z.string().min(1),
  quote: z.string().min(1),
});
export type BadLensQuote = z.infer<typeof BadLensQuote>;

export const RecapLabels = z.strictObject({
  version: z.literal(RECAP_LABELS_VERSION),
  seed: z.int(),
  rates: z.strictObject({ bad_sentence: z.number(), bad_lens_quote: z.number() }),
  /** How many sentences and lens fields each kind was drawn from. */
  eligible: z.strictObject({
    bad_sentence: z.int().nonnegative(),
    bad_lens_quote: z.int().nonnegative(),
  }),
  sentences: z.array(BadSentence),
  lens: z.array(BadLensQuote),
});
export type RecapLabels = z.infer<typeof RecapLabels>;

/** A script's lens, by its number (`d001` is the first). */
export function recapLensOf(script: Pick<DebriefScript, "id">): RecapLensId | null {
  const n = Number(script.id.slice(1));
  return RECAP_LENS_ROTATION[(n - 1) % RECAP_LENS_ROTATION.length] ?? null;
}

/** A script's transcript as the session holds it: each turn's biased final, in order. */
export function recapScriptUtterances(script: DebriefScript): UtteranceFinalV2[] {
  return script.turns.map((_, index) => understandingUtterances(script, index).biased);
}

const isText = (field: ExpectedField | undefined): field is ExpectedField & { value: string } =>
  field !== undefined && typeof field.value === "string";

/** A script's proposals as the recap's prompt shows them: the ground truth, records by name. */
export function recapScriptProposals(script: DebriefScript): RecapProposal[] {
  return script.turns.flatMap((turn) =>
    turn.expect.map((proposal): RecapProposal => {
      const named = "named" in proposal ? proposal.named : undefined;
      const id = proposal.target.id;
      const record =
        proposal.type === "contact" ? null : id ? demoEntity(id).name : (named?.quote ?? null);
      const fields: Record<string, string | number> = {};
      for (const [name, field] of Object.entries(proposal.fields) as [string, ExpectedField][]) {
        fields[name] = field.value;
      }
      return { type: proposal.type, record, fields };
    }),
  );
}

type Sentence = SubmitRecapInput["sentences"][number];

const fieldsOf = (proposal: ExpectedProposal) =>
  proposal.fields as Readonly<Record<string, ExpectedField | undefined>>;

/** A sentence's quotes, each once, at most four. */
function quotesOf(...fields: (ExpectedField | undefined | string)[]): string[] {
  const out: string[] = [];
  for (const field of fields) {
    const quote = typeof field === "string" ? field : field?.quote;
    if (quote && !out.includes(quote) && out.length < 4) out.push(quote);
  }
  return out;
}

/** The main field of a proposal, for a headline when the debrief has no note. */
function mainField(proposal: ExpectedProposal): ExpectedField | undefined {
  const fields = fieldsOf(proposal);
  return fields.body ?? fields.title ?? fields.text ?? fields.name ?? fields.stage ?? fields.amount;
}

/** What the headline says, and the words it quotes. */
function headline(script: DebriefScript): Sentence {
  const proposals = script.turns.flatMap((turn) => turn.expect);
  const note = proposals.find((proposal) => proposal.type === "note");
  if (note) {
    const body = fieldsOf(note).body;
    const named = "named" in note ? note.named?.quote : undefined;
    if (isText(body)) return { kind: "headline", text: body.value, quotes: quotesOf(body, named) };
  }
  const first = proposals[0];
  const field = first ? mainField(first) : undefined;
  if (!first || !field) throw new Error(`${script.id} has no proposal to headline`);
  const text =
    typeof field.value === "string"
      ? field.value
      : `The deal moves to $${field.value.toLocaleString("en-US")}.`;
  return {
    kind: "headline",
    text: /[.!?]$/u.test(text) ? text : `${text}.`,
    quotes: quotesOf(field),
  };
}

/** The ground truth's recap: a headline, a next step per task, a commitment per commitment. */
export function groundTruthSentences(script: DebriefScript): Sentence[] {
  const out: Sentence[] = [headline(script)];
  for (const proposal of script.turns.flatMap((turn) => turn.expect)) {
    const fields = fieldsOf(proposal);
    if (proposal.type === "task" && isText(fields.title)) {
      const due = fields.dueDate;
      out.push({
        kind: "next_step",
        text: due ? `${fields.title.value}, ${due.quote}.` : `${fields.title.value}.`,
        quotes: quotesOf(fields.title, due),
      });
    }
    if (proposal.type === "commitment" && isText(fields.text)) {
      const due = fields.dueDate;
      out.push({
        kind: "commitment",
        text: due ? `${fields.text.value}, ${due.quote}.` : `${fields.text.value}.`,
        quotes: quotesOf(fields.text, fields.counterpart, due),
      });
    }
  }
  if (out.length > 12) throw new Error(`${script.id}: more than 12 ground-truth sentences`);
  return out;
}

/** The ground truth's answer for each lens field: the words of the field that answers it. */
const LENS_SOURCES: Readonly<
  Record<RecapLensId, Readonly<Record<string, (proposals: ExpectedProposal[]) => string | null>>>
> = (() => {
  const first = (proposals: ExpectedProposal[], type: string, field: string) => {
    for (const proposal of proposals) {
      if (proposal.type !== type) continue;
      const found = fieldsOf(proposal)[field];
      if (found) return found.quote;
    }
    return null;
  };
  const due = (proposals: ExpectedProposal[]) =>
    first(proposals, "task", "dueDate") ?? first(proposals, "deal_update", "closeDate");
  return {
    meddic: {
      metrics: (p) => first(p, "deal_update", "amount"),
      economic_buyer: () => null,
      decision_criteria: () => null,
      decision_process: (p) => first(p, "deal_update", "stage"),
      identified_pain: (p) => first(p, "note", "body"),
      champion: (p) => first(p, "contact", "name"),
    },
    spiced: {
      situation: (p) => first(p, "note", "body"),
      pain: () => null,
      impact: () => null,
      critical_event: (p) => first(p, "deal_update", "closeDate"),
      decision: (p) => first(p, "deal_update", "stage"),
    },
    bant: {
      budget: (p) => first(p, "deal_update", "amount"),
      authority: (p) => first(p, "contact", "title"),
      need: (p) => first(p, "note", "body"),
      timeline: due,
    },
  };
})();

/** The ground truth's lens answers for a script: one per field, in the lens's order. */
export function groundTruthLens(
  script: DebriefScript,
): { field: string; quote: string | null }[] | null {
  const lens = recapLensOf(script);
  if (!lens) return null;
  const proposals = script.turns.flatMap((turn) => turn.expect);
  return Object.entries(LENS_SOURCES[lens]).map(([field, source]) => ({
    field,
    quote: source(proposals),
  }));
}

/** Words a model "corrects" a quote into: a synonym for one word, the quote's meaning kept. */
const SYNONYMS: Readonly<Record<string, string>> = {
  send: "email",
  sent: "emailed",
  quote: "estimate",
  revised: "updated",
  meeting: "call",
  call: "meeting",
  next: "following",
  by: "before",
  wants: "would like",
  want: "would like",
  expand: "grow",
  pricing: "price list",
  proposal: "offer",
  contract: "agreement",
  demo: "walkthrough",
  schedule: "set up",
  follow: "check",
  deal: "opportunity",
  team: "group",
  week: "few days",
};

/** Paraphrases of a quote, in the order to try: a synonym, then two rewordings. */
function paraphrases(quote: string): string[] {
  const words = quote.split(" ");
  const out: string[] = [];
  const at = words.findIndex((word) => SYNONYMS[word.toLowerCase()] !== undefined);
  if (at >= 0) {
    const swapped = [...words];
    swapped[at] = SYNONYMS[(words[at] as string).toLowerCase()] as string;
    out.push(swapped.join(" "));
  }
  if (words.length > 1) out.push([...words.slice(1), words[0]].join(" "));
  out.push(`basically ${words.slice(1).join(" ") || quote} as discussed`);
  return out;
}

/** Statements a model invents: never said in any of the 200 debriefs (the generator checks). */
const INVENTED: readonly (readonly [string, string])[] = [
  ["They'll sign the contract by Monday.", "they'll sign the contract by Monday"],
  ["The customer agreed to a three-year term.", "they agreed to a three-year term"],
  ["Set up a board demo next week.", "set up a board demo next week"],
  ["Loop legal into the security review.", "loop legal into the security review"],
  ["Their CFO already approved the budget.", "the CFO already approved the budget"],
  ["Book the onsite workshop for March.", "book the onsite workshop for March"],
  ["Send the case study to their procurement lead.", "send the case study to procurement"],
  ["They're dropping the incumbent vendor this quarter.", "dropping the incumbent this quarter"],
];

/** Lens quotes a model invents: never said either. */
const INVENTED_LENS: readonly string[] = [
  "the budget is already approved for next year",
  "the CFO signs off on anything over fifty thousand",
  "they have to go live before the audit",
  "it costs them two hundred hours a month",
  "their board decides in the spring",
];

interface SentenceSite {
  readonly script: string;
  /** Its position among the script's ground-truth sentences. */
  readonly index: number;
}

interface LensSite {
  readonly script: string;
  readonly lens: RecapLensId;
  readonly field: string;
}

function order<T extends { script: string }>(key: (item: T) => string) {
  return (a: T, b: T) => {
    const x = key(a);
    const y = key(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
}

/** Chooses each kind's sites by a seeded shuffle and writes each bad sentence and lens quote. */
export function seedRecapErrors(scripts: readonly DebriefScript[]): RecapLabels {
  const sentenceSites: SentenceSite[] = [];
  const lensSites: LensSite[] = [];
  for (const script of scripts) {
    const count = groundTruthSentences(script).length;
    for (let index = 0; index < count; index++) sentenceSites.push({ script: script.id, index });
    const lens = recapLensOf(script);
    for (const answer of groundTruthLens(script) ?? []) {
      if (lens && answer.quote === null) {
        lensSites.push({ script: script.id, lens, field: answer.field });
      }
    }
  }
  const byId = new Map(scripts.map((script) => [script.id, script]));
  const utterancesOf = (id: string) => {
    const script = byId.get(id);
    if (!script) throw new Error(`no script ${id}`);
    return recapScriptUtterances(script);
  };
  const choose = <T extends { script: string }>(
    kind: keyof typeof RECAP_ERROR_RATES,
    sites: readonly T[],
    key: (item: T) => string,
  ): T[] => {
    const rng = createRng(subSeed(RECAP_SEED, kind));
    const count = Math.round(RECAP_ERROR_RATES[kind] * sites.length);
    return rng.shuffle(sites).slice(0, count).sort(order(key));
  };
  const rng = createRng(subSeed(RECAP_SEED, "values"));
  const chosen = choose(
    "bad_sentence",
    sentenceSites,
    (site) => `${site.script}:${String(site.index).padStart(2, "0")}`,
  );
  const sentences: BadSentence[] = [];
  // Inserting a bad sentence shifts the ones after it in the same script.
  const inserted = new Map<string, number>();
  for (const site of chosen) {
    const script = byId.get(site.script) as DebriefScript;
    const good = groundTruthSentences(script)[site.index] as Sentence;
    const utterances = utterancesOf(site.script);
    const unfound = (quote: string) => locateQuote(quote, utterances) === null;
    const error = rng.pick(BAD_SENTENCE_KINDS);
    let text: string;
    let quotes: string[];
    if (error === "paraphrased") {
      quotes = good.quotes.map((quote) => {
        const found = paraphrases(quote).find(unfound);
        if (!found)
          throw new Error(`${site.script}: no paraphrase of a quote leaves the transcript`);
        return found;
      });
      text = paraphrases(good.text)[0] ?? good.text;
    } else {
      const [inventedText, inventedQuote] = rng.pick(
        INVENTED.filter(([, quote]) => unfound(quote)),
      );
      text = inventedText;
      quotes = [inventedQuote];
    }
    if (!quotes.every(unfound))
      throw new Error(`${site.script}: a seeded quote is in the transcript`);
    const shift = inserted.get(site.script) ?? 0;
    sentences.push({
      script: site.script,
      index: site.index + shift + 1,
      error,
      kind: good.kind,
      after: site.index,
      text,
      quotes,
    });
    inserted.set(site.script, shift + 1);
  }
  const lens: BadLensQuote[] = [];
  for (const site of choose(
    "bad_lens_quote",
    lensSites,
    (item) => `${item.script}:${item.field}`,
  )) {
    const utterances = utterancesOf(site.script);
    const options = INVENTED_LENS.filter((quote) => locateQuote(quote, utterances) === null);
    lens.push({ ...site, quote: rng.pick(options) });
  }
  return {
    version: RECAP_LABELS_VERSION,
    seed: RECAP_SEED,
    rates: { ...RECAP_ERROR_RATES },
    eligible: { bad_sentence: sentenceSites.length, bad_lens_quote: lensSites.length },
    sentences,
    lens,
  };
}
/** A script's recap as the cassette's model writes it: the ground truth, with its seeded errors. */
export function recapCassetteInput(script: DebriefScript, labels: RecapLabels): SubmitRecapInput {
  const sentences: Sentence[] = [...groundTruthSentences(script)];
  const bad = labels.sentences
    .filter((item) => item.script === script.id)
    .sort((a, b) => a.index - b.index);
  for (const item of bad) {
    sentences.splice(item.index, 0, { kind: item.kind, text: item.text, quotes: [...item.quotes] });
  }
  const answers = groundTruthLens(script);
  const lens = answers
    ? {
        fields: answers.map((answer) => {
          const seeded = labels.lens.find(
            (item) => item.script === script.id && item.field === answer.field,
          );
          return { field: answer.field, quote: seeded ? seeded.quote : answer.quote };
        }),
      }
    : null;
  return { sentences, lens };
}

/**
 * Plausible token counts, not measurements: the instructions and the tool schema (about 1,000),
 * the transcript and the proposals (a token per 4 characters); the answer by its characters, and
 * on Groq some hidden reasoning.
 */
function tokens(script: DebriefScript, input: SubmitRecapInput) {
  const transcript = script.turns.reduce((sum, turn) => sum + turn.heard.biased.length, 0);
  return {
    input:
      600 +
      Math.ceil(JSON.stringify(SUBMIT_RECAP_JSON_SCHEMA).length / 4) +
      Math.ceil(transcript / 2),
    output: 30 + Math.ceil(JSON.stringify(input).length / 4),
    reasoning: 120 + 20 * input.sentences.length,
  };
}

/** One script's recap as a recordable scenario. */
export function recapScenario(
  provider: LlmProvider,
  script: DebriefScript,
  labels: RecapLabels,
): RecapScenario {
  const input = recapCassetteInput(script, labels);
  return {
    name: script.id,
    description: script.title,
    provider,
    input: {
      utterances: recapScriptUtterances(script),
      proposals: recapScriptProposals(script),
      lens: recapLensOf(script),
    },
    responses: [recapResponse(provider, input, tokens(script, input), `${script.id}_recap`)],
    expect: { outcome: "created", attempts: 1 },
  };
}

/** Every provider's recap cassettes: one cassette per script, one interaction each. */
export async function generateRecapCassettes(
  scripts: readonly DebriefScript[],
  labels: RecapLabels,
): Promise<Record<LlmProvider, CassetteFile>> {
  const files = {} as Record<LlmProvider, CassetteFile>;
  for (const provider of EVAL_PROVIDERS) {
    const cassettes: Record<string, Cassette> = {};
    for (const script of scripts) {
      cassettes[script.id] = (await recordRecap(recapScenario(provider, script, labels))).cassette;
    }
    files[provider] = {
      version: CASSETTE_VERSION,
      provider,
      model: LLM_MODELS[provider],
      source: "hand-made",
      cassettes,
    };
  }
  return files;
}

/** The labels file's bytes: two-space JSON, one label per line inside it. */
export function serializeRecapLabels(labels: RecapLabels): string {
  const { sentences, lens, ...header } = labels;
  const head = JSON.stringify(header, null, 2).slice(0, -2);
  const lines = (items: readonly unknown[]) =>
    items.length === 0
      ? "[]"
      : `[\n${items.map((item) => `    ${JSON.stringify(item)}`).join(",\n")}\n  ]`;
  return `${head},\n  "sentences": ${lines(sentences)},\n  "lens": ${lines(lens)}\n}\n`;
}
