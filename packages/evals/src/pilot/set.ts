// The pilot kit's set, `pilot.v1` (Phase 5 spec WP7, decision 13; ADR-0039): its name and seed,
// the shape of its manifest, and the shape of the results file a participant downloads from
// /pilot (§4.8). Pure: the builder, the analysis, the tests, and the /pilot page share it.
import { ProposalReviewedV2 } from "@earshot/core";
import { z } from "zod";

/** An ISO 8601 time, as `@earshot/core`'s events write them. */
const Timestamp = z.iso.datetime({ offset: true });

/** The set's name, in its manifest and in every results file. */
export const PILOT_SET = "pilot.v1";
/** The set's seed: SHA-256's eighth initial hash word (the seeded errors' is the seventh). */
export const PILOT_SEED = 0x5be0cd19;
/** The provider whose offline cassettes the set's logs come from (spec WP7 step 1). */
export const PILOT_PROVIDER = "anthropic";

/** The set's size (spec WP7 step 1): 10 sessions with 40 proposals between them. */
export const PILOT_SESSION_COUNT = 10;
export const PILOT_PROPOSAL_COUNT = 40;
/** Seeded wrong accounts per participant: 4 the pipeline flags, 4 it doesn't. */
export const PILOT_FLAGGED = 4;
export const PILOT_SILENT = 4;
/** The practice session's cards, from the hand-written scripts, with no seeded errors. */
export const PILOT_PRACTICE_COUNT = 3;
/** A silent error's probability is drawn from this range (spec WP7 step 1). */
export const SILENT_P_RANGE = [0.88, 0.93] as const;
/** Participants: `?p=1` to `?p=5`, each with an order of their own, and `?p=ci` for WP8. */
export const PILOT_PARTICIPANTS = ["1", "2", "3", "4", "5"] as const;
export const CI_PARTICIPANT = "ci";

export const MANIFEST_FORMAT = 1;
export const RESULTS_FORMAT = 1;

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
/** The set's sessions, `s01` to `s10`, in script order. */
export const PilotSessionId = z.string().regex(/^s(?:0[1-9]|10)$/);
export type PilotSessionId = z.infer<typeof PilotSessionId>;
const ScriptId = z.string().regex(/^d\d{3}$/);
const EntityId = z.string().regex(/^(?:co|ct|deal)_\d{3}$/);
const Order = z.array(PilotSessionId).length(PILOT_SESSION_COUNT);

/** One session's log in the set. */
const ManifestSession = z.strictObject({
  /** `s01` to `s10`, or `practice`. */
  id: z.union([PilotSessionId, z.literal("practice")]),
  /** The debrief it was run from. */
  script: ScriptId,
  /** Its JSONL file, beside the manifest. */
  file: z.string().regex(/^(?:s(?:0[1-9]|10)|practice)\.jsonl$/),
  /** SHA-256 of the file's bytes. */
  sha256: Hex64,
  /** The session id inside the log. */
  sessionId: z.uuid(),
  /** The account open in Earshot when it started (the script's), if any. */
  focusEntityId: EntityId.nullable(),
  /** The call time its relative dates resolve against, and the rep's time zone. */
  callTime: Timestamp,
  timeZone: z.string().min(1),
  /** Its proposals, in the order the log creates them. */
  proposals: z.array(z.uuid()).min(1),
});
export type ManifestSession = z.infer<typeof ManifestSession>;

const Candidate = z.strictObject({ entityId: EntityId.nullable(), p: z.number().min(0).max(1) });

const SeededCommon = {
  session: PilotSessionId,
  proposalId: z.uuid(),
  /** Where the proposal sits in its script: 0-based, as the scripts' arrays index them. */
  script: ScriptId,
  turn: z.int().nonnegative(),
  index: z.int().nonnegative(),
};

/**
 * A seeded wrong account, with the right answer:
 * - **flagged:** a snapped name the pipeline's own witness conflict turned into a question, the
 *   snapped record first. Unchanged from the run. Caught: "New" (a null record) or a rejection.
 * - **silent:** a correct link swapped to its sound-alike sibling, `basis: "sound"`, p in
 *   0.88–0.93, the right record second, only `link_uncertain:target`. Caught: the right record,
 *   or a rejection.
 */
export const SeededError = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("flagged"),
    ...SeededCommon,
    /** The record the biased stream snapped the new name onto: the question's first choice. */
    snapped: EntityId,
    /** The question's candidates, as the card offers them. */
    candidates: z.array(Candidate).min(2),
    right: z.strictObject({ entityId: z.null() }),
  }),
  z.strictObject({
    kind: z.literal("silent"),
    ...SeededCommon,
    /** The sound-alike sibling the card shows as linked. */
    shown: EntityId,
    p: z.number().min(SILENT_P_RANGE[0]).max(SILENT_P_RANGE[1]),
    /** The confusable group the two share (`@earshot/demo-crm`). */
    group: z.string().min(1),
    candidates: z.array(Candidate).min(2),
    right: z.strictObject({ entityId: EntityId }),
  }),
]);
export type SeededError = z.infer<typeof SeededError>;

/** Counts by likely-edit tier, the quiet tier split as §4.4's metrics split it. */
export const TierCounts = z.strictObject({
  proposals: z.int().nonnegative(),
  loud: z.int().nonnegative(),
  /** Quiet with a note on the card (`markedShare`'s quiet part). */
  quiet: z.int().nonnegative(),
  /** Quiet with only the note beside the record's name (`nameNoteShare`). */
  nameNote: z.int().nonnegative(),
  none: z.int().nonnegative(),
});
export type TierCounts = z.infer<typeof TierCounts>;

export const ProposalTier = z.strictObject({
  session: z.union([PilotSessionId, z.literal("practice")]),
  proposalId: z.uuid(),
  type: z.string().min(1),
  tier: z.enum(["loud", "quiet", "none"]),
  /** `tierOf`'s reasons, `tier:kind@field`, in its order. */
  reasons: z.array(z.string()),
  nameNote: z.enum(["sound", "context"]).nullable(),
  seeded: z.enum(["flagged", "silent"]).nullable(),
});
export type ProposalTier = z.infer<typeof ProposalTier>;

/**
 * `manifest.json`. `sha256` is the set's hash: SHA-256 of this file's text as written with that
 * line left out (`setSha256`), so it covers every log (by its own hash), the seeded errors and
 * their right answers, the orders, and the tier mix. The pre-registration names it, and every
 * results file carries it.
 */
export const PilotManifest = z.strictObject({
  format: z.literal(MANIFEST_FORMAT),
  set: z.literal(PILOT_SET),
  sha256: Hex64,
  seed: z.int(),
  /** What the logs were built from, so a rebuild on other inputs shows. */
  source: z.strictObject({
    provider: z.literal(PILOT_PROVIDER),
    linker: z.string().min(1),
    scriptsSha256: Hex64,
    errorsSha256: Hex64,
    cassetteSha256: Hex64,
  }),
  sessions: z.array(ManifestSession).length(PILOT_SESSION_COUNT),
  practice: ManifestSession,
  seeded: z.array(SeededError).length(PILOT_FLAGGED + PILOT_SILENT),
  /** Each participant's order of the sessions (a seeded, balanced Latin rectangle), and CI's. */
  orders: z.strictObject({
    "1": Order,
    "2": Order,
    "3": Order,
    "4": Order,
    "5": Order,
    ci: Order,
  }),
  /** The tier mix as built: all 40, the 8 seeded, the other 32, and the practice. Never tuned. */
  tiers: z.strictObject({
    all: TierCounts,
    seeded: TierCounts,
    other: TierCounts,
    practice: TierCounts,
    proposals: z.array(ProposalTier),
  }),
});
export type PilotManifest = z.infer<typeof PilotManifest>;

/** The participant's label in a results file: P1 to P5, or `ci` for the scripted reviewer. */
export const ParticipantLabel = z.string().regex(/^(?:P[1-5]|ci)$/);

/** The browser, as far as the results file says: its engine and whether it was a phone or tablet. */
export const PilotBrowser = z.strictObject({
  engine: z.enum(["blink", "gecko", "webkit", "unknown"]),
  mobile: z.boolean(),
});
export type PilotBrowser = z.infer<typeof PilotBrowser>;

/** A review the pilot page wrote: `proposal.reviewed` v2, on the pilot surface. */
const PilotReview = ProposalReviewedV2.refine((review) => review.surface === "pilot", {
  message: 'a pilot review is on the "pilot" surface',
});

/**
 * The results file /pilot downloads (spec §4.8): these fields and nothing else. No name, user
 * agent, screen size, or address; the reviews are v2 payloads on the pilot surface, the practice
 * reviews kept apart.
 */
export const PilotResults = z.strictObject({
  format: z.literal(RESULTS_FORMAT),
  set: z.literal(PILOT_SET),
  setSha256: Hex64,
  participant: ParticipantLabel,
  order: Order,
  startedAt: Timestamp,
  finishedAt: Timestamp,
  browser: PilotBrowser,
  reviews: z.array(PilotReview),
  practice: z.array(PilotReview),
});
export type PilotResults = z.infer<typeof PilotResults>;

/** The participant label for `?p=`: `1` → `P1`, `ci` → `ci`; null for anything else. */
export function participantLabel(p: string | null | undefined): string | null {
  if (p === CI_PARTICIPANT) return CI_PARTICIPANT;
  return (PILOT_PARTICIPANTS as readonly string[]).includes(p ?? "") ? `P${p}` : null;
}

/** The orders' key for a participant label: `P1` → `1`, `ci` → `ci`. */
export function orderKey(label: string): keyof PilotManifest["orders"] | null {
  if (label === CI_PARTICIPANT) return CI_PARTICIPANT;
  const p = label.startsWith("P") ? label.slice(1) : "";
  return (PILOT_PARTICIPANTS as readonly string[]).includes(p)
    ? (p as (typeof PILOT_PARTICIPANTS)[number])
    : null;
}

/** SHA-256 of a string's UTF-8 bytes, as lowercase hex, with WebCrypto (Node, workerd, browsers). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The manifest's text as written: two-space JSON and a final newline. */
export function manifestText(manifest: unknown): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * The set's hash: SHA-256 of the manifest's text without its `sha256` line. Works on the manifest
 * as written or as parsed back: JSON keeps the keys in the order they were written.
 */
export async function setSha256(manifest: Readonly<Record<string, unknown>>): Promise<string> {
  const { sha256: _, ...body } = manifest;
  return sha256Hex(manifestText(body));
}
