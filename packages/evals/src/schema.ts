// The debrief script format (Phase 3 spec, WP11 step 1). A script is what one eval fixture says
// and what it should produce: 2 to 5 push-to-talk turns, the silence before each, the Kokoro
// voice that speaks them, the call time relative dates resolve against, and the proposals each
// turn should yield. lab/scripts/render_debriefs.py renders the audio from the same files.
//
// Phase 4 (WP8) adds three optional fields for extractor v2 and the entity linker, without a
// format version bump: the account open in Earshot (`focusEntityId`), how the rep named each
// proposal's record (`named`, which tool schema v2's drafts quote), and what the linker should
// decide (`decision`, derived when absent; see `expectedDecision`). Names are written as said:
// the extractor no longer sees the CRM list, so "Akme" stays "Akme" and the linker resolves it.
import type { ProposalType, TargetDecision } from "@earshot/core";
import { z } from "zod";

export const DEBRIEF_FORMAT_VERSION = 1;

/**
 * Kokoro v1.0's 28 English voices (`voices-v1.0.bin`): American female and male, then British
 * female and male. The renderer passes `en-gb` to Kokoro for the British ones.
 */
export const KOKORO_VOICES = [
  "af_alloy",
  "af_aoede",
  "af_bella",
  "af_heart",
  "af_jessica",
  "af_kore",
  "af_nicole",
  "af_nova",
  "af_river",
  "af_sarah",
  "af_sky",
  "am_adam",
  "am_echo",
  "am_eric",
  "am_fenrir",
  "am_liam",
  "am_michael",
  "am_onyx",
  "am_puck",
  "am_santa",
  "bf_alice",
  "bf_emma",
  "bf_isabella",
  "bf_lily",
  "bm_daniel",
  "bm_fable",
  "bm_george",
  "bm_lewis",
] as const;
export const KokoroVoice = z.enum(KOKORO_VOICES);
export type KokoroVoice = z.infer<typeof KokoroVoice>;

export const MIN_TURNS = 2;
export const MAX_TURNS = 5;
/**
 * Silence before a turn, in ms. The e2e test presses push-to-talk shortly before each turn and
 * releases 200 ms after its speech ends, so the gap has to hold both, plus timing jitter.
 */
export const MIN_PAUSE_MS = 800;
export const MAX_PAUSE_MS = 5_000;
/** The first turn's pause is the lead-in after Arm, when the fake microphone starts playing. */
export const MIN_LEAD_IN_MS = 1_000;
/** One press of push-to-talk: far below the socket's 4,000-character utterance cap. */
export const MAX_TURN_CHARS = 600;
export const MAX_PROPOSALS_PER_TURN = 5;

/**
 * What a turn exercises that the data can't show by itself. Numbers and relative dates are
 * read off the expected fields (coverage.ts); these two need the author's word, and a test checks
 * the text backs it: a negation word for `negation`, and a correction marker before an expected
 * quote for `self_correction`.
 */
export const TURN_TAGS = ["negation", "self_correction"] as const;
export const TurnTag = z.enum(TURN_TAGS);
export type TurnTag = z.infer<typeof TurnTag>;

/** A demo CRM id (`@earshot/demo-crm`): `co_011`, `ct_045`, `deal_028`. */
export const DemoEntityId = z.string().regex(/^(?:co|ct|deal)_\d{3}$/);

/**
 * A field as the model should draft it: the value the CRM should store, and the exact words of
 * the turn it comes from. The quote is what `understand` looks for, so it must be a substring
 * of the turn's text.
 */
function quoted<V extends z.ZodType>(value: V) {
  return z.strictObject({ value, quote: z.string().min(1) });
}
const Text = quoted(z.string().min(1));
/** A calendar date, resolved against the script's call time in its time zone. */
const Day = quoted(z.iso.date());
/** US dollars. */
const Usd = quoted(z.number().int().positive());

const target = DemoEntityId.nullable();

/** A record kind: `@earshot/core`'s `EntityKind`. */
const Kind = z.enum(["company", "contact", "deal"]);

/**
 * How the rep named a proposal's record in its turn, as tool schema v2 drafts it: the words as
 * said (a substring of the turn), the kind of record they name (the target's kind when absent),
 * and the company said in the same breath as a contact or deal. Absent when the turn names no
 * record: the draft's target is then null, and the open account stands in (`implied_target`).
 */
const Named = z.strictObject({
  quote: z.string().min(1),
  kind: Kind.optional(),
  company: z.string().min(1).optional(),
});
export type Named = z.infer<typeof Named>;

/**
 * What the linker should decide about a proposal's target. Absent means the plain reading of
 * `target`: a record is linked, and null is a new contact, or no target for other types.
 */
const Decision = z.enum(["linked", "ask", "new", "none"]);

/** Extractor v2's fields on a proposal whose record is a target (every type but contact). */
const targeting = { target, named: Named.optional(), decision: Decision.optional() };

/**
 * One proposal a turn should yield: its type, its target (a demo CRM id, or null for a new
 * contact or a record the session doesn't hold), and its fields. A field left out is one the
 * rep didn't mention; the cassettes send it as `null`, as the tool schema requires.
 */
export const ExpectedProposal = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("note"),
    ...targeting,
    fields: z.strictObject({ body: Text }),
  }),
  z.strictObject({
    type: z.literal("task"),
    ...targeting,
    fields: z.strictObject({ title: Text, dueDate: Day.optional() }),
  }),
  z.strictObject({
    type: z.literal("contact"),
    target,
    // A contact's record is the person its `name` field names, so it's never `named` otherwise.
    decision: Decision.optional(),
    fields: z.strictObject({
      name: Text,
      title: Text.optional(),
      company: Text.optional(),
      email: Text.optional(),
      phone: Text.optional(),
    }),
  }),
  z.strictObject({
    type: z.literal("deal_update"),
    ...targeting,
    fields: z
      .strictObject({ stage: Text.optional(), amount: Usd.optional(), closeDate: Day.optional() })
      .refine((fields) => Object.keys(fields).length > 0, "a deal update changes a field"),
  }),
  z.strictObject({
    type: z.literal("commitment"),
    ...targeting,
    fields: z.strictObject({
      text: Text,
      counterpart: Text.optional(),
      dueDate: Day.optional(),
    }),
  }),
]);
export type ExpectedProposal = z.infer<typeof ExpectedProposal>;
export type ExpectedField = { readonly value: string | number; readonly quote: string };

/** How the rep named a proposal's record, or null: never for a contact, whose record is its name. */
export function namedOf(proposal: ExpectedProposal): Named | null {
  return "named" in proposal ? (proposal.named ?? null) : null;
}

/**
 * What the linker should decide about a proposal's target: `decision` when the script says, else
 * "linked" for a target, "new" for a contact with none, and "none" for anything else with none.
 */
export function expectedDecision(proposal: ExpectedProposal): TargetDecision {
  if (proposal.decision) return proposal.decision;
  if (proposal.target !== null) return "linked";
  return proposal.type === "contact" ? "new" : "none";
}

/** Text as the fake speech-to-text adapter emits it: single spaces, no line breaks, trimmed. */
export function isNormalizedText(text: string): boolean {
  return text === text.replace(/\s+/g, " ").trim();
}

function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const DebriefTurn = z.strictObject({
  pauseBeforeMs: z.int().min(MIN_PAUSE_MS).max(MAX_PAUSE_MS),
  /** What the rep says in one press. It is also the transcript the fake adapter emits. */
  text: z
    .string()
    .min(1)
    .max(MAX_TURN_CHARS)
    .refine(isNormalizedText, "single spaces, no line breaks, no leading or trailing space"),
  tags: z.array(TurnTag).optional(),
  /** The proposals this turn should yield, in the order the rep says them. Empty for none. */
  expect: z.array(ExpectedProposal).max(MAX_PROPOSALS_PER_TURN),
});
export type DebriefTurn = z.infer<typeof DebriefTurn>;

export const DebriefScript = z
  .strictObject({
    version: z.literal(DEBRIEF_FORMAT_VERSION),
    /** `d001` to `d030`, matching the file name. */
    id: z.string().regex(/^d\d{3}$/),
    /** A line for people: the account and what happens. */
    title: z.string().min(1).max(120),
    voice: KokoroVoice,
    /** Kokoro's speed; 1 when absent. */
    speed: z.number().min(0.8).max(1.25).optional(),
    /**
     * When the call happened. The session runs with this call time, so relative dates ("by
     * Thursday") resolve against it, in `timeZone`, and the cassettes are keyed on it.
     */
    callTime: z.iso.datetime({ offset: true }),
    /** The rep's IANA time zone. */
    timeZone: z.string().refine(isTimeZone, "an IANA time zone"),
    /**
     * The account open in Earshot while the rep debriefs: a demo CRM company. The session's
     * `start` carries it, the prompt names it, and the linker reads its family as context.
     */
    focusEntityId: z
      .string()
      .regex(/^co_\d{3}$/)
      .optional(),
    turns: z.array(DebriefTurn).min(MIN_TURNS).max(MAX_TURNS),
  })
  .superRefine((script, ctx) => {
    const first = script.turns[0];
    if (first && first.pauseBeforeMs < MIN_LEAD_IN_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["turns", 0, "pauseBeforeMs"],
        message: `the lead-in is at least ${MIN_LEAD_IN_MS} ms`,
      });
    }
  });
export type DebriefScript = z.infer<typeof DebriefScript>;

/**
 * The fields an eval compares exactly. The rest are free text in the model's own words (a note's
 * body, a task's title, a commitment's text and counterpart): CI's cassettes reproduce them
 * word for word, but a live model won't, and Phase 4 scores them.
 */
export const KEY_FIELDS: Readonly<Record<ProposalType, readonly string[]>> = {
  note: [],
  task: ["dueDate"],
  contact: ["name", "title", "company", "email", "phone"],
  deal_update: ["stage", "amount", "closeDate"],
  commitment: ["dueDate"],
};

/** An expected proposal's fields as `[name, field]` pairs, in the order they're written. */
export function expectedFields(proposal: ExpectedProposal): [string, ExpectedField][] {
  const fields: [string, ExpectedField][] = [];
  const entries = Object.entries(proposal.fields) as [string, ExpectedField | undefined][];
  for (const [name, field] of entries) if (field !== undefined) fields.push([name, field]);
  return fields;
}
