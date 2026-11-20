// The debrief script format (Phase 3 spec, WP11 step 1). A script is what one eval fixture says
// and what it should produce: 2 to 5 push-to-talk turns, the silence before each, the Kokoro
// voice that speaks them, the call time relative dates resolve against, and the proposals each
// turn should yield. lab/scripts/render_debriefs.py renders the audio from the same files.
//
// Phase 4 (WP8) added three optional fields for extractor v2 and the entity linker, without a
// format version bump: the account open in Earshot (`focusEntityId`), how the rep named each
// proposal's record (`named`, which tool schema v2's drafts quote), and what the linker should
// decide (`decision`, derived when absent). Names are written as said: the extractor no longer
// sees the CRM list, so "Akme" stays "Akme" and the linker resolves it.
//
// Format v2 (Phase 4 WP10, ADR-0031) is eval harness v1's:
// - per turn, `heard.biased` and `heard.unbiased`: what the production stream (keyterm-biased)
//   and the second witness transcribed. Both default to `text`, what was said. The renderer
//   speaks `text`; the fake speech-to-text adapter emits `heard.biased`; the second witness's
//   comparison reads `heard.unbiased`. Every quote comes from `heard.biased`;
// - each expected target is `{ id, decision }`: the demo CRM record (null for a new record or
//   none) and what the linker should decide, after the second witness;
// - optional `expectFlags` per proposal: risk flags the pipeline must raise on it;
// - the `meeting` proposal type (tool schema v2);
// - optional `noise: { kind, snrDb }` per script, as lab/scripts/debrief_noise.py mixes it.
//
// v1 files (d001–d030) are read as they are and upgraded in code (`upgradeDebriefScript`), so the
// renderer's hashes and the e2e cassettes, which depend on their bytes, never move.
import { type ProposalTypeV2, RiskKindV2, type TargetDecision } from "@earshot/core";
import { z } from "zod";

/** The format generated scripts are written in. */
export const DEBRIEF_FORMAT_VERSION = 2;
/** The format of the 30 hand-written scripts, upgraded in code when they load. */
export const DEBRIEF_FORMAT_V1 = 1;

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
 * read off the expected fields (coverage.ts); these need the author's word, and a test checks the
 * text backs it: a negation word for `negation`, a correction marker before an expected quote for
 * `self_correction`, and (format v2) a filler, a repeated word, or a restart for `disfluency`.
 */
export const TURN_TAGS = ["negation", "self_correction", "disfluency"] as const;
export const TurnTag = z.enum(TURN_TAGS);
export type TurnTag = z.infer<typeof TurnTag>;

/** A demo CRM id (`@earshot/demo-crm`): `co_011`, `ct_045`, `deal_028`. */
export const DemoEntityId = z.string().regex(/^(?:co|ct|deal)_\d{3}$/);

/**
 * The background noise lab/scripts/debrief_noise.py mixes under a script's speech at a
 * signal-to-noise ratio (Phase 4 WP10b). Its kinds and SNR range, which a test holds to the
 * Python module's. Only live runs hear it: CI's fake adapter ignores the audio.
 */
export const NOISE_KINDS = ["none", "car", "street", "cafe"] as const;
export const MIN_SNR_DB = -10;
export const MAX_SNR_DB = 60;
export const Noise = z.strictObject({
  kind: z.enum(NOISE_KINDS),
  snrDb: z.number().min(MIN_SNR_DB).max(MAX_SNR_DB),
});
export type Noise = z.infer<typeof Noise>;

/**
 * A field as the model should draft it: the value the CRM should store, and the exact words of
 * the turn it comes from. The quote is what `understand` looks for, so it must be a substring
 * of what the production stream heard (`heard.biased`, which defaults to the turn's text).
 */
function quoted<V extends z.ZodType>(value: V) {
  return z.strictObject({ value, quote: z.string().min(1) });
}
const Text = quoted(z.string().min(1));
/** A calendar date, resolved against the script's call time in its time zone. */
const Day = quoted(z.iso.date());
/** US dollars. */
const Usd = quoted(z.number().int().positive());
/** A time of day, `HH:MM` on a 24-hour clock (a meeting's start). */
const Clock = quoted(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/));

/** A record kind: `@earshot/core`'s `EntityKind`. */
const Kind = z.enum(["company", "contact", "deal"]);

/**
 * How the rep named a proposal's record in its turn, as tool schema v2 drafts it: the words as
 * heard (a substring of `heard.biased`), the kind of record they name (the target's kind when
 * absent), and the company said in the same breath as a contact or deal. Absent when the turn
 * names no record: the draft's target is then null, and the open account stands in
 * (`implied_target`).
 */
const Named = z.strictObject({
  quote: z.string().min(1),
  kind: Kind.optional(),
  company: z.string().min(1).optional(),
});
export type Named = z.infer<typeof Named>;

/** What the linker should decide about a proposal's target, after the second witness. */
const Decision = z.enum(["linked", "ask", "new", "none"]);

// ---------------------------------------------------------------------------------------------
// Format v1: the 30 hand-written scripts, as Phase 3 and WP8 wrote them

const targetV1 = DemoEntityId.nullable();

/** Extractor v2's fields on a proposal whose record is a target (every type but contact). */
const targetingV1 = { target: targetV1, named: Named.optional(), decision: Decision.optional() };

/**
 * One proposal in format v1: its type, its target (a demo CRM id, or null for a new contact or a
 * record the session doesn't hold), its fields, and (WP8) how the rep named it and what the
 * linker should decide when that isn't the plain reading of `target`.
 */
export const ExpectedProposalV1 = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("note"),
    ...targetingV1,
    fields: z.strictObject({ body: Text }),
  }),
  z.strictObject({
    type: z.literal("task"),
    ...targetingV1,
    fields: z.strictObject({ title: Text, dueDate: Day.optional() }),
  }),
  z.strictObject({
    type: z.literal("contact"),
    target: targetV1,
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
    ...targetingV1,
    fields: z
      .strictObject({ stage: Text.optional(), amount: Usd.optional(), closeDate: Day.optional() })
      .refine((fields) => Object.keys(fields).length > 0, "a deal update changes a field"),
  }),
  z.strictObject({
    type: z.literal("commitment"),
    ...targetingV1,
    fields: z.strictObject({
      text: Text,
      counterpart: Text.optional(),
      dueDate: Day.optional(),
    }),
  }),
]);
export type ExpectedProposalV1 = z.infer<typeof ExpectedProposalV1>;

// ---------------------------------------------------------------------------------------------
// Format v2

/**
 * The expected target: the demo CRM record (null for a new record, or when there's none) and the
 * linker's decision, after the second witness. A "linked" target names its record. An "ask" names
 * the record the rep meant, or null when they meant a new one: the question must offer it.
 */
export const ExpectedTarget = z
  .strictObject({ id: DemoEntityId.nullable(), decision: Decision })
  .refine((target) => target.decision !== "linked" || target.id !== null, {
    message: "a linked target names its record",
  })
  .refine((target) => (target.decision !== "new" && target.decision !== "none") || !target.id, {
    message: "a new target, or none, has no record",
  });
export type ExpectedTarget = z.infer<typeof ExpectedTarget>;

/** Risk flags (`RiskKindV2`) the pipeline must raise on a proposal; others may come too. */
const ExpectFlags = z
  .array(RiskKindV2)
  .min(1)
  .max(6)
  .refine((flags) => new Set(flags).size === flags.length, "each flag once");

const targetingV2 = {
  target: ExpectedTarget,
  named: Named.optional(),
  expectFlags: ExpectFlags.optional(),
};

/**
 * One proposal a turn should yield (format v2): its type, its expected target, how the rep named
 * its record, the flags it must carry, and its fields. A field left out is one the rep didn't
 * mention; the cassettes send it as `null`, as the tool schema requires.
 */
export const ExpectedProposal = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("note"),
    ...targetingV2,
    fields: z.strictObject({ body: Text }),
  }),
  z.strictObject({
    type: z.literal("task"),
    ...targetingV2,
    fields: z.strictObject({ title: Text, dueDate: Day.optional() }),
  }),
  z.strictObject({
    type: z.literal("contact"),
    // A contact's record is the person its `name` field names, so it's never `named` otherwise.
    target: ExpectedTarget,
    expectFlags: ExpectFlags.optional(),
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
    ...targetingV2,
    fields: z
      .strictObject({ stage: Text.optional(), amount: Usd.optional(), closeDate: Day.optional() })
      .refine((fields) => Object.keys(fields).length > 0, "a deal update changes a field"),
  }),
  z.strictObject({
    type: z.literal("commitment"),
    ...targetingV2,
    fields: z.strictObject({
      text: Text,
      counterpart: Text.optional(),
      dueDate: Day.optional(),
    }),
  }),
  z.strictObject({
    type: z.literal("meeting"),
    ...targetingV2,
    fields: z.strictObject({
      title: Text,
      date: Day.optional(),
      time: Clock.optional(),
      attendees: Text.optional(),
    }),
  }),
]);
export type ExpectedProposal = z.infer<typeof ExpectedProposal>;
export type ExpectedField = { readonly value: string | number; readonly quote: string };

/** How the rep named a proposal's record, or null: never for a contact, whose record is its name. */
export function namedOf(proposal: ExpectedProposal | ExpectedProposalV1): Named | null {
  return "named" in proposal ? (proposal.named ?? null) : null;
}

/** What the linker should decide about a proposal's target, after the second witness. */
export function expectedDecision(proposal: ExpectedProposal): TargetDecision {
  return proposal.target.decision;
}

/** A v1 proposal's decision: `decision`, else "linked" for a target, "new" for a contact, "none". */
function decisionV1(proposal: ExpectedProposalV1): TargetDecision {
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

const TurnText = z
  .string()
  .min(1)
  .max(MAX_TURN_CHARS)
  .refine(isNormalizedText, "single spaces, no line breaks, no leading or trailing space");

const turnBase = {
  pauseBeforeMs: z.int().min(MIN_PAUSE_MS).max(MAX_PAUSE_MS),
  /** What the rep says in one press: what the renderer speaks. */
  text: TurnText,
  tags: z
    .array(TurnTag)
    .optional()
    .refine((tags) => tags === undefined || new Set(tags).size === tags.length, "each tag once"),
};

const DebriefTurnV1 = z.strictObject({
  ...turnBase,
  tags: z.array(z.enum(["negation", "self_correction"])).optional(),
  /** The proposals this turn should yield, in the order the rep says them. Empty for none. */
  expect: z.array(ExpectedProposalV1).max(MAX_PROPOSALS_PER_TURN),
});
export type DebriefTurnV1 = z.infer<typeof DebriefTurnV1>;

/**
 * What each witness transcribed, where it differs from what was said: the production stream,
 * primed with the session's keyterms (`biased`), and the second witness (`unbiased`).
 */
const Heard = z.strictObject({ biased: TurnText.optional(), unbiased: TurnText.optional() });

const DebriefTurnFile = z.strictObject({
  ...turnBase,
  heard: Heard.optional(),
  expect: z.array(ExpectedProposal).max(MAX_PROPOSALS_PER_TURN),
});

const scriptBase = {
  /** `d001` to `d200`, matching the file name. */
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
};

function leadIn(script: { turns: readonly { pauseBeforeMs: number }[] }, ctx: z.RefinementCtx) {
  const first = script.turns[0];
  if (first && first.pauseBeforeMs < MIN_LEAD_IN_MS) {
    ctx.addIssue({
      code: "custom",
      path: ["turns", 0, "pauseBeforeMs"],
      message: `the lead-in is at least ${MIN_LEAD_IN_MS} ms`,
    });
  }
}

/** A script in format v1, as d001–d030 sit on disk. */
export const DebriefScriptV1 = z
  .strictObject({
    version: z.literal(DEBRIEF_FORMAT_V1),
    ...scriptBase,
    turns: z.array(DebriefTurnV1).min(MIN_TURNS).max(MAX_TURNS),
  })
  .superRefine(leadIn);
export type DebriefScriptV1 = z.infer<typeof DebriefScriptV1>;

/** A script in format v2, as the generator writes d031–d200. */
export const DebriefScriptFile = z
  .strictObject({
    version: z.literal(DEBRIEF_FORMAT_VERSION),
    ...scriptBase,
    noise: Noise.optional(),
    turns: z.array(DebriefTurnFile).min(MIN_TURNS).max(MAX_TURNS),
  })
  .superRefine(leadIn);
export type DebriefScriptFile = z.infer<typeof DebriefScriptFile>;

/** A turn as the evals read it: format v2, with both witnesses' transcripts filled in. */
export type DebriefTurn = Omit<z.infer<typeof DebriefTurnFile>, "heard"> & {
  readonly heard: { readonly biased: string; readonly unbiased: string };
};

/** A script as the evals read it: format v2, every turn's transcripts filled in. */
export type DebriefScript = Omit<DebriefScriptFile, "turns"> & {
  readonly turns: readonly DebriefTurn[];
};

/** A v1 proposal in format v2: its target becomes `{ id, decision }`; nothing else changes. */
export function upgradeProposal(proposal: ExpectedProposalV1): ExpectedProposal {
  const decision = decisionV1(proposal);
  const target = { id: proposal.target, decision };
  if (proposal.type === "contact") {
    return { type: "contact", target, fields: proposal.fields };
  }
  const named = proposal.named ? { named: proposal.named } : {};
  switch (proposal.type) {
    case "note":
      return { type: "note", target, ...named, fields: proposal.fields };
    case "task":
      return { type: "task", target, ...named, fields: proposal.fields };
    case "deal_update":
      return { type: "deal_update", target, ...named, fields: proposal.fields };
    case "commitment":
      return { type: "commitment", target, ...named, fields: proposal.fields };
  }
}

function withHeard(turn: {
  text: string;
  heard?: { biased?: string; unbiased?: string } | undefined;
}): DebriefTurn["heard"] {
  return {
    biased: turn.heard?.biased ?? turn.text,
    unbiased: turn.heard?.unbiased ?? turn.text,
  };
}

/** Any script in format v2 as the evals read it: v1 upgraded, and both transcripts filled in. */
export function upgradeDebriefScript(script: DebriefScriptV1 | DebriefScriptFile): DebriefScript {
  if (script.version === DEBRIEF_FORMAT_VERSION) {
    return {
      ...script,
      turns: script.turns.map((turn) => ({ ...turn, heard: withHeard(turn) })),
    };
  }
  const { version: _version, turns, ...rest } = script;
  return {
    version: DEBRIEF_FORMAT_VERSION,
    ...rest,
    turns: turns.map((turn) => ({
      pauseBeforeMs: turn.pauseBeforeMs,
      text: turn.text,
      heard: withHeard(turn),
      ...(turn.tags ? { tags: turn.tags } : {}),
      expect: turn.expect.map(upgradeProposal),
    })),
  };
}

/**
 * A debrief script in either format, read as format v2: a v1 file is upgraded, and every turn's
 * `heard` is filled in from its text. Parsing an upgraded script again gives the same script.
 */
export const DebriefScript = z
  .discriminatedUnion("version", [DebriefScriptV1, DebriefScriptFile])
  .transform((script): DebriefScript => upgradeDebriefScript(script));

/**
 * The fields an eval compares exactly. The rest are free text in the model's own words (a note's
 * body, a task's title, a commitment's text and counterpart, a meeting's title and attendees):
 * CI's cassettes reproduce them word for word, but a live model won't.
 */
export const KEY_FIELDS: Readonly<Record<ProposalTypeV2, readonly string[]>> = {
  note: [],
  task: ["dueDate"],
  contact: ["name", "title", "company", "email", "phone"],
  deal_update: ["stage", "amount", "closeDate"],
  commitment: ["dueDate"],
  meeting: ["date", "time"],
};

/** An expected proposal's fields as `[name, field]` pairs, in the order they're written. */
export function expectedFields(
  proposal: ExpectedProposal | ExpectedProposalV1,
): [string, ExpectedField][] {
  const fields: [string, ExpectedField][] = [];
  const entries = Object.entries(proposal.fields) as [string, ExpectedField | undefined][];
  for (const [name, field] of entries) if (field !== undefined) fields.push([name, field]);
  return fields;
}

/** The fields of a script's turn as each witness heard it: `heard.biased` unless asked. */
export function heardText(
  turn: Pick<DebriefTurn, "heard">,
  witness: "biased" | "unbiased" = "biased",
): string {
  return turn.heard[witness];
}
