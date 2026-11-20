// The confusable-name set's items (spec §4.5), as `linking/confusable.v1.jsonl` holds them, one
// per line. Everything a linker may read is under `biased`, `unbiased`, `type`, `context.focus
// EntityId`, and `context.recent`; the rest is ground truth and bookkeeping, and
// `linkingCase()` (linkers.ts) strips it before a linker sees an item.
import { EntityKind, ProposalType } from "@earshot/core";
import { z } from "zod";

export const CONFUSABLE_SET_VERSION = "confusable.v1";
export const CONFUSABLE_SET_FILE = "linking/confusable.v1.jsonl";

/** Items in the set: the spec's 600, so the test split is its 360. */
export const SET_SIZE = 600;
/** The calibration split's share, per class and confusable group; the rest is the test split. */
export const CALIBRATION_SHARE = 0.4;

export const ITEM_CLASSES = ["A", "B", "C", "D", "E1", "E2", "F", "G"] as const;
export const ItemClass = z.enum(ITEM_CLASSES);
export type ItemClass = z.infer<typeof ItemClass>;

/** The spec's class shares (§4.5), fixed before the linker is written. */
export const CLASS_SHARES: Readonly<Record<ItemClass, number>> = {
  A: 0.2,
  B: 0.22,
  C: 0.36,
  D: 0.05,
  E1: 0.08,
  E2: 0.04,
  F: 0.04,
  G: 0.01,
};

export const Expect = z.enum(["link", "new", "ask"]);
export type Expect = z.infer<typeof Expect>;

/** Each class's best possible decision. E2's "ask" comes through the second witness. */
export const CLASS_EXPECT: Readonly<Record<ItemClass, Expect>> = {
  A: "link",
  B: "link",
  C: "link",
  D: "ask",
  E1: "new",
  E2: "ask",
  F: "new",
  G: "ask",
};

export const CLASS_LABELS: Readonly<Record<ItemClass, string>> = {
  A: "CRM name heard exactly",
  B: "CRM name misheard, unique by sound or tail",
  C: "Sound-alike separated by context",
  D: "Sound-alike, nothing separates it",
  E1: "New sound-alike, heard as new",
  E2: "New sound-alike, snapped to a CRM spelling",
  F: "New name unlike any CRM name",
  G: "Open account is the wrong sibling",
};

/** Items per class: the shares of `SET_SIZE`, rounded so they sum to it. */
export const CLASS_COUNTS: Readonly<Record<ItemClass, number>> = (() => {
  const counts = Object.fromEntries(
    ITEM_CLASSES.map((itemClass) => [itemClass, Math.round(CLASS_SHARES[itemClass] * SET_SIZE)]),
  ) as Record<ItemClass, number>;
  const total = ITEM_CLASSES.reduce((sum, itemClass) => sum + counts[itemClass], 0);
  if (total !== SET_SIZE) throw new Error(`class counts sum to ${total}, not ${SET_SIZE}`);
  return counts;
})();

export const Split = z.enum(["calibration", "test"]);
export type Split = z.infer<typeof Split>;

/** `NEW` for a record the CRM doesn't have; otherwise a demo CRM id. */
export const GoldId = z.union([z.literal("NEW"), z.string().regex(/^(co|ct|deal)_\d{3}$/)]);
export type GoldId = z.infer<typeof GoldId>;

/** Where a mention sits in a transcript: `transcript.slice(start, end) === text`. */
export const Span = z.strictObject({
  start: z.int().nonnegative(),
  end: z.int().positive(),
  text: z.string().min(1),
});
export type Span = z.infer<typeof Span>;

/** One witness's transcript of the turn. */
export const Reading = z.strictObject({
  transcript: z.string().min(1),
  /** The words that named the record: what the extractor quotes as the target. */
  mention: Span,
  /** The company said in the same breath, if one was. */
  company: Span.nullable(),
  /** The simulator's rules that acted on the mention ("vowel", "snap", ...); "company:" for the company's. */
  noise: z.array(z.string().min(1)),
});
export type Reading = z.infer<typeof Reading>;

/** What separated a class C item's sound-alikes. */
export const Cue = z.enum(["company", "focus", "recent", "tail"]);
export type Cue = z.infer<typeof Cue>;

export const ConfusableItem = z.strictObject({
  id: z.string().regex(/^cf-\d{4}$/),
  split: Split,
  class: ItemClass,
  /** The proposal type the mention targets for: it decides which record kinds may be linked. */
  type: ProposalType,
  /** What the rep said, spelled as the CRM (or, for a new record, the decoy list) spells it. */
  said: z.strictObject({ text: z.string().min(1), kind: EntityKind }),
  biased: Reading,
  unbiased: Reading,
  context: z.strictObject({
    /** The account open in Earshot. */
    focusEntityId: z.string().min(1).nullable(),
    /** The company said in the same breath, with its gold id. */
    company: z.strictObject({ said: z.string().min(1), gold: GoldId }).nullable(),
    /** Records linked earlier in the session. */
    recent: z.array(z.string().min(1)),
  }),
  gold: GoldId,
  /** The best possible decision, after the second witness. */
  expect: Expect,
  /** The confusable group of the gold record, or of the record a new name sounds like. */
  group: z.string().min(1).nullable(),
  /** Class C only: the context that separates the sound-alikes. */
  cue: Cue.nullable(),
});
export type ConfusableItem = z.infer<typeof ConfusableItem>;

/** What's wrong with an item beyond its schema: spans that don't match, labels that disagree. */
export function itemProblems(item: ConfusableItem): string[] {
  const problems: string[] = [];
  for (const witness of ["biased", "unbiased"] as const) {
    const reading = item[witness];
    for (const [name, span] of [
      ["mention", reading.mention],
      ["company", reading.company],
    ] as const) {
      if (span === null) continue;
      if (reading.transcript.slice(span.start, span.end) !== span.text) {
        problems.push(`${witness} ${name} span isn't its text`);
      }
    }
    if ((reading.company === null) !== (item.context.company === null)) {
      problems.push(`${witness} company span and context.company disagree`);
    }
  }
  if (item.expect !== CLASS_EXPECT[item.class]) problems.push("expect isn't its class's");
  if ((item.cue !== null) !== (item.class === "C")) problems.push("cue is set outside class C");
  const isNew = item.gold === "NEW";
  if (isNew !== ["E1", "E2", "F"].includes(item.class)) problems.push("gold NEW outside E1, E2, F");
  return problems;
}

/** One item per line, keys in schema order, and a final newline. */
export function serializeConfusableSet(items: readonly ConfusableItem[]): string {
  return items
    .map((item) => JSON.stringify(ConfusableItem.parse(item)))
    .join("\n")
    .concat("\n");
}

/** Parses a set file, naming the line of the first item that's malformed or inconsistent. */
export function parseConfusableSet(text: string): ConfusableItem[] {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.map((line, index) => {
    const result = ConfusableItem.safeParse(JSON.parse(line));
    if (!result.success) {
      throw new Error(`line ${index + 1}: ${result.error.issues[0]?.message ?? "invalid item"}`);
    }
    const problems = itemProblems(result.data);
    if (problems.length > 0)
      throw new Error(`line ${index + 1} (${result.data.id}): ${problems[0]}`);
    return result.data;
  });
}
