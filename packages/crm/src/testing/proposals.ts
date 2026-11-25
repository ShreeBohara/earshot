// Proposals, approvals, and plan inputs for tests (Phase 6 WP2): views as `@earshot/events` folds
// them, built directly, so the planner's tests, the conformance suite, and later packages' tests
// can make a `PlanInput` without a session log. Worker-safe: no Node APIs and no Vitest.
import type {
  CrmMapping,
  CrmObject,
  ExternalRef,
  FieldEdit,
  FieldValue,
  ProposalTypeV2,
  SeenField,
  TargetV2,
} from "@earshot/core";
import type { ProposalView, ReviewView } from "@earshot/events";
import type { CrmSchema, MirrorRef, PlanInput } from "../adapter";

/** A UUID-shaped id from a small number, as `@earshot/events/testing` makes them. */
export function testUuid(n: number): string {
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** When the fixtures' proposals were made: a debrief on 2026-11-24, in the afternoon in Chicago. */
export const PROPOSED_AT = "2026-11-24T21:15:00.000Z";

const EVIDENCE = {
  utteranceId: testUuid(0x2001),
  span: [0, 12] as [number, number],
  audioMs: [1_000, 2_400] as [number, number],
  confidence: 0.94,
};

/** A record a proposal names, for `proposalView`'s target: linked, or a new record's words. */
export type TargetSpec =
  | { readonly linked: MirrorRef }
  | { readonly new: { readonly kind: "company" | "contact" | "deal"; readonly words: string } }
  | { readonly none: true };

/**
 * A proposal as the projection folds it: its type, its fields with placeholder evidence, and its
 * target (linked to a mirror record, a new record named by words, or none), proposed, unreviewed.
 */
export function proposalView(
  type: ProposalTypeV2,
  fields: Readonly<Record<string, FieldValue>>,
  target: TargetSpec,
  options: { readonly id?: string; readonly ts?: string; readonly company?: MirrorRef | null } = {},
): ProposalView {
  const mention = (quote: string) => ({ quote, evidence: EVIDENCE });
  let resolved: TargetV2;
  if ("linked" in target) {
    resolved = {
      decision: "linked",
      entityId: target.linked.entityId,
      kind: kindOf(target.linked.ref.object),
      basis: "exact",
      p: 0.97,
      mention: mention(target.linked.name),
      company: null,
      candidates: [{ entityId: target.linked.entityId, p: 0.97 }],
    };
  } else if ("new" in target) {
    resolved = {
      decision: "new",
      entityId: null,
      kind: target.new.kind,
      basis: null,
      p: 0.9,
      mention: mention(target.new.words),
      company: options.company
        ? { ...mention(options.company.name), entityId: options.company.entityId }
        : null,
      candidates: [{ entityId: null, p: 0.9 }],
    };
  } else {
    resolved = {
      decision: "none",
      entityId: null,
      kind: null,
      basis: null,
      p: null,
      mention: null,
      company: null,
      candidates: [],
    };
  }
  return {
    proposalId: options.id ?? testUuid(0x3001),
    type,
    targetEntityId: resolved.entityId,
    target: resolved,
    status: "approved",
    fields: Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [name, { value, evidence: EVIDENCE }]),
    ),
    riskFlags: [],
    conflicts: [],
    supersedes: null,
    supersededBy: null,
    snoozedUntil: null,
    followups: [],
    seq: 4,
    ts: options.ts ?? PROPOSED_AT,
    review: null,
    sync: null,
  };
}

function kindOf(object: CrmObject): "company" | "contact" | "deal" {
  if (object === "company" || object === "contact" || object === "deal") return object;
  throw new TypeError(`a proposal targets a company, a contact, or a deal, not a ${object}`);
}

/**
 * An approval as the projection folds it: approved (or edited, with `editDiff`), by a person in
 * the inbox, with what the card showed (`seen`, by field), eligible to sync 30 s later.
 */
export function reviewView(
  options: {
    readonly id?: string;
    readonly editDiff?: Readonly<Record<string, FieldEdit>>;
    readonly seen?: Readonly<Record<string, SeenField>>;
    readonly entityId?: string | null;
  } = {},
): ReviewView {
  const edited = options.editDiff !== undefined && Object.keys(options.editDiff).length > 0;
  return {
    reviewId: options.id ?? testUuid(0x7001),
    decision: edited ? "edited" : "approved",
    target: options.entityId === undefined ? null : { entityId: options.entityId },
    editDiff: edited ? { ...options.editDiff } : null,
    mode: "single",
    batchId: null,
    policy: null,
    undoes: null,
    reason: null,
    seen: {
      tier: "none",
      fields: { ...(options.seen ?? {}) },
      target: null,
      relinked: null,
      clip: "none",
    },
    timing: { decisionMs: 1_200, handlingMs: 1_500 },
    input: "keyboard",
    surface: "inbox",
    syncEligibleAt: "2026-11-24T21:20:30.000Z",
    by: { userId: "u_rep", auth: { method: "passkey", signedInAt: "2026-11-24T21:00:00.000Z" } },
    seq: 9,
    ts: "2026-11-24T21:20:00.000Z",
  };
}

/** A mirror record: its row's id, the CRM's record, and its name. */
export function mirrorRef(
  ref: ExternalRef,
  name: string,
  entityId: string = testUuid(0x6000 + ref.id.length),
): MirrorRef {
  return { entityId, ref, name };
}

/** A plan's input, with the defaults filled in: no company, the rep in Chicago with no owner. */
export function planInput(parts: {
  readonly proposal: ProposalView;
  readonly review?: ReviewView;
  readonly target?: MirrorRef | null;
  readonly company?: MirrorRef | null;
  readonly mapping: CrmMapping;
  readonly schema: CrmSchema;
  readonly rep?: PlanInput["rep"];
  readonly key: string;
  readonly markers: readonly string[];
}): PlanInput {
  return {
    proposal: parts.proposal,
    review: parts.review ?? reviewView(),
    target: parts.target ?? null,
    company: parts.company ?? null,
    mapping: parts.mapping,
    schema: parts.schema,
    rep: parts.rep ?? { ownerId: null, timeZone: "America/Chicago" },
    key: parts.key,
    markers: parts.markers,
  };
}
