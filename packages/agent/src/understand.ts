// The understanding step (Phase 4 spec §4.3, WP8 step 3; ADR-0027): turns the proposals the model
// drafted into `proposal.created` v2 payloads, less their ids. Pure, run in SessionDO after the
// turn's one extraction call, in four steps:
//
// 1. Evidence: every quote (each field's, the target's, and its company's) is found in the turn's
//    biased utterances (`locateQuote`) and becomes evidence (`evidenceFor`).
// 2. Link: the words that named the record go to the entity linker, with the session's index, the
//    open account, earlier links, and the companies said in the turn (`link`, ADR-0028).
// 3. Normalize and 4. check: each field's value against its quote (`checkField`, ADR-0030): dates,
//    times, and amounts read deterministically, negations, self-corrections, and support. A
//    unique reading replaces a value that disagrees with it, which `norm.llmValue` keeps.
//
// Spec §4.3's rules:
// - An unquoted target, whose words aren't in the transcript, is "none", flagged `unsupported` on
//   the target. It's never linked.
// - An implied target: no record named, and an account open in Earshot. The target is that
//   account, basis "focus", flagged `implied_target`. A deal update can't target a company, so it
//   takes the open account's only deal; with no deal or several, it has no target.
// - A contact proposal links on its `name` field, with its `company` field as context.
// - A deal named only by its company resolves to that company's only deal (the linker's
//   "context" basis); with several deals, the linker asks.
//
// `unsupported` means one thing everywhere (ADR-0027): the words the model cited don't support
// what it wrote. A field whose quote isn't in the turn is dropped, and the flag names it; a date,
// time, or amount whose quote holds no such value keeps its value, flagged; a target whose quote
// isn't in the turn links nothing.
//
// Flags the Phase 3 patterns raised (`risk.ts`) are gone but two: `negation` now comes from the
// NegEx-style check, and `low_confidence` stays. `date` and `number`, raised on every date and
// number, gave way to the normalizers' checks of the value itself (ADR-0030).
import {
  type EntityKind,
  type ProposalCreatedV2,
  type ProposalFieldV2,
  type ProposalTypeV2,
  type RiskFlagV2,
  TARGET_FIELD,
  type TargetV2,
  type UtteranceFinalV2,
} from "@earshot/core";
import { checkField, type FieldCheck, fieldKind } from "@earshot/understanding/faithfulness";
import {
  isLinkUncertain,
  LINKER_PARAMS_V1,
  type LinkContext,
  type LinkerParams,
  type LinkIndex,
  type LinkResult,
  link,
  type MentionInput,
} from "@earshot/understanding/link";
import { evidenceFor, locateQuote, type QuoteLocation, spanText } from "./evidence";
import { linkedMention, linkerMention, TARGET_KINDS, withRecentLinks } from "./link-context";
import { type ToolField, type ToolProposal, toolTarget } from "./schema";

export { linkerMention, MAX_RECENT_LINKS, withRecentLinks } from "./link-context";

/** A `proposal.created` v2 payload without its `proposalId`, which `SessionDO` mints. */
export type ProposalDraft = Omit<ProposalCreatedV2, "proposalId">;

/**
 * Evidence below this confidence gets `low_confidence` (target). With word timings it's the
 * lowest word's confidence, so one shaky word in a quote is enough.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.7;

/** The session as the linker sees it: what `start` and earlier turns established. */
export interface LinkSession {
  /** The session's records, indexed once (`buildLinkIndex`), and again after the object wakes. */
  readonly index: LinkIndex;
  /** The account open in Earshot (`start.focusEntityId`), or null. */
  readonly focusEntityId: string | null;
  /** Records linked earlier in the session, most recent first. */
  readonly recent: readonly string[];
  /** The linker's frozen parameters: `LINKER_PARAMS_V1` when absent. */
  readonly params?: LinkerParams;
}

export interface UnderstandContext {
  /** The turn's biased utterances: the only place a quote may come from. */
  readonly utterances: readonly UtteranceFinalV2[];
  readonly session: LinkSession;
  /** When the call happened (ISO 8601) and the rep's IANA time zone, for dates. */
  readonly callTime: string;
  readonly timeZone: string;
  /** The turn's other named records: their companies count as said in the turn. */
  readonly turnMentions?: readonly MentionInput[];
}

/** No target: nothing named, or nothing the words could link. */
const NO_TARGET: TargetV2 = {
  decision: "none",
  entityId: null,
  kind: null,
  basis: null,
  p: null,
  mention: null,
  company: null,
  candidates: [],
};

const flag = (kind: RiskFlagV2["kind"], field?: string): RiskFlagV2 =>
  field === undefined ? { kind } : { kind, field };

/** The value as stored: trimmed text. An empty value counts as not said, like `null`. */
function cleanValue(field: ToolField): string | number {
  return typeof field.value === "string" ? field.value.trim() : field.value;
}

/**
 * The words that named a proposal's record, as the linker takes them: from its target, or for a
 * contact from its `name` field and `company` field. Null when nothing was named or found.
 */
export function draftMention(
  draft: ToolProposal,
  utterances: readonly UtteranceFinalV2[],
): MentionInput | null {
  const located = (quote: string | undefined) =>
    quote === undefined ? null : locateQuote(quote, utterances);
  if (draft.type === "contact") {
    const name = located(draft.fields.name.quote);
    if (name === null) return null;
    const company = located(draft.fields.company?.quote);
    return {
      text: spanText(name),
      kind: "contact",
      companyText: company ? spanText(company) : null,
    };
  }
  const target = toolTarget(draft);
  if (target === null) return null;
  const mention = located(target.quote);
  if (mention === null) return null;
  const company = located(target.company?.quote);
  // As the linker reads it, but with the company said beside a deal kept: it was said in the turn.
  const companyText = company ? spanText(company) : null;
  return { ...linkerMention(spanText(mention), target.kind, companyText), companyText };
}

/**
 * Understands one drafted proposal (spec §4.3): its fields' evidence and checks, and its target.
 * Returns null for a proposal left with no supported field, as Phase 3 did.
 */
export function understand(draft: ToolProposal, ctx: UnderstandContext): ProposalDraft | null {
  const { utterances } = ctx;
  const turnText = utterances.map((utterance) => utterance.text).join("\n");

  // 1. Evidence for every field, in the draft's order.
  const located: { name: string; value: string | number; location: QuoteLocation }[] = [];
  const unsupported: RiskFlagV2[] = [];
  for (const [name, field] of Object.entries(draft.fields) as [string, ToolField | null][]) {
    if (field === null) continue;
    const value = cleanValue(field);
    if (value === "") {
      if (field.quote.trim() !== "") unsupported.push(flag("unsupported", name));
      continue;
    }
    const location = locateQuote(field.quote, utterances);
    if (location === null) {
      unsupported.push(flag("unsupported", name));
      continue;
    }
    located.push({ name, value, location });
  }
  if (located.length === 0) return null;

  // 3 and 4. Each value against its quote. A meeting's time reads its date, so the date goes first.
  const checks = new Map<string, FieldCheck>();
  const check = (entry: (typeof located)[number], date: string | null) => {
    const result = checkField(
      {
        field: entry.name,
        kind: fieldKind(draft.type, entry.name),
        value: entry.value,
        utterance: entry.location.utterance.text,
        span: entry.location.span,
      },
      { turnText, callTime: ctx.callTime, timeZone: ctx.timeZone, date },
    );
    checks.set(entry.name, result);
    return result;
  };
  const dateEntry = located.find((entry) => entry.name === "date");
  const dateValue = dateEntry ? check(dateEntry, null).value : null;
  const fields: Record<string, ProposalFieldV2> = {};
  const fieldFlags: RiskFlagV2[] = [];
  for (const entry of located) {
    const result =
      checks.get(entry.name) ??
      check(entry, typeof dateValue === "string" && entry.name === "time" ? dateValue : null);
    const evidence = evidenceFor(entry.location);
    fields[entry.name] = {
      value: result.value,
      evidence,
      ...(result.norm ? { norm: result.norm } : {}),
    };
    fieldFlags.push(...result.flags.map((item) => flag(item.kind, item.field)));
    if (evidence.confidence < LOW_CONFIDENCE_THRESHOLD) {
      fieldFlags.push(flag("low_confidence", entry.name));
    }
  }

  // 2. The target.
  const { target, flags: targetFlags } = resolveTarget(draft, ctx);
  return {
    type: draft.type,
    target,
    fields,
    riskFlags: [...fieldFlags, ...unsupported, ...targetFlags],
    supersedes: null,
    linker: (ctx.session.params ?? LINKER_PARAMS_V1).version,
  };
}

/** The linker's context for a mention among the kinds `kinds`. */
function linkContext(ctx: UnderstandContext, kinds: LinkContext["kinds"]): LinkContext {
  const { session } = ctx;
  return {
    index: session.index,
    focusEntityId: session.focusEntityId,
    recent: session.recent,
    turnMentions: ctx.turnMentions ?? [],
    params: session.params ?? LINKER_PARAMS_V1,
    ...(kinds === undefined ? {} : { kinds }),
  };
}

function resolveTarget(
  draft: ToolProposal,
  ctx: UnderstandContext,
): { target: TargetV2; flags: RiskFlagV2[] } {
  if (draft.type === "contact") {
    const name = locateQuote(draft.fields.name.quote, ctx.utterances);
    // No name in the transcript: the field was dropped as unsupported, and nothing is linked.
    if (name === null) return { target: NO_TARGET, flags: [] };
    const company = draft.fields.company
      ? locateQuote(draft.fields.company.quote, ctx.utterances)
      : null;
    return linkedTarget(draft.type, name, "contact", company, ctx);
  }
  const drafted = toolTarget(draft);
  if (drafted === null) return impliedTarget(draft.type, ctx.session);
  const mention = locateQuote(drafted.quote, ctx.utterances);
  if (mention === null) {
    // Spec §4.3: an unquoted target is never linked.
    return {
      target: { ...NO_TARGET, kind: drafted.kind },
      flags: [flag("unsupported", TARGET_FIELD)],
    };
  }
  const company = drafted.company ? locateQuote(drafted.company.quote, ctx.utterances) : null;
  return linkedTarget(draft.type, mention, drafted.kind, company, ctx);
}

/** The linker's decision on a named record, as `TargetV2`, and the flags it raises. */
function linkedTarget(
  type: ProposalTypeV2,
  mention: QuoteLocation,
  kind: MentionInput["kind"],
  company: QuoteLocation | null,
  ctx: UnderstandContext,
): { target: TargetV2; flags: RiskFlagV2[] } {
  const text = spanText(mention);
  const companyText = company ? spanText(company) : null;
  const result: LinkResult = link(
    linkerMention(text, kind, companyText),
    linkContext(ctx, TARGET_KINDS[type]),
  );
  const target: TargetV2 = {
    decision: result.decision,
    entityId: result.entityId,
    kind,
    basis: result.basis,
    p: result.p,
    mention: { quote: text, evidence: evidenceFor(mention) },
    company:
      company && companyText !== null
        ? {
            quote: companyText,
            evidence: evidenceFor(company),
            entityId: linkCompany(companyText, ctx),
          }
        : null,
    candidates: result.candidates.map((candidate) => ({
      entityId: candidate.entityId,
      p: candidate.p,
    })),
  };
  const flags: RiskFlagV2[] = [];
  if (result.decision === "ask") flags.push(flag("ambiguous_target", TARGET_FIELD));
  if (result.decision === "new") flags.push(flag("new_entity", TARGET_FIELD));
  if (isLinkUncertain(result)) flags.push(flag("link_uncertain", TARGET_FIELD));
  return { target, flags };
}

/** The company said with a contact or deal, linked on its own: its record if linked, else null. */
function linkCompany(text: string, ctx: UnderstandContext): string | null {
  const result = link({ text, kind: "company" }, linkContext(ctx, ["company"]));
  return result.decision === "linked" ? result.entityId : null;
}

/**
 * No record named (spec §4.3): the open account, if the proposal type can target it, or for a
 * deal update the open account's only deal. Otherwise no target.
 */
function impliedTarget(
  type: ProposalTypeV2,
  session: LinkSession,
): { target: TargetV2; flags: RiskFlagV2[] } {
  const { focusEntityId, index } = session;
  const account = focusEntityId === null ? undefined : index.byId.get(focusEntityId)?.entity;
  if (!account) return { target: NO_TARGET, flags: [] };
  const kinds = TARGET_KINDS[type];
  let entityId: string | null = kinds.includes(account.kind) ? account.id : null;
  if (entityId === null && kinds.includes("deal")) {
    const deals = (index.children.get(account.id) ?? []).filter(
      (record) => record.entity.kind === "deal",
    );
    if (deals.length === 1) entityId = deals[0]?.entity.id ?? null;
  }
  if (entityId === null) return { target: NO_TARGET, flags: [] };
  return {
    target: { ...NO_TARGET, decision: "linked", entityId, basis: "focus" },
    flags: [flag("implied_target", TARGET_FIELD)],
  };
}

/**
 * What a proposal's target linker read: the mention as it read it (null when nothing was named),
 * the kinds allowed, the earlier links the proposal saw, and the turn's other named records. The
 * second witness is compared with the same context (WP9, `witnessTurn`).
 */
export interface LinkDraft {
  readonly mention: MentionInput | null;
  readonly kinds: readonly EntityKind[];
  readonly recent: readonly string[];
  readonly turnMentions: readonly MentionInput[];
}

export interface TurnUnderstanding {
  /** The turn's proposals, in the order the model drafted them, without the ones dropped. */
  readonly proposals: readonly ProposalDraft[];
  /** For each proposal, in the same order: what its target's linker read. */
  readonly links: readonly LinkDraft[];
  /** The session's earlier links once this turn's are added (`withRecentLinks`). */
  readonly recent: readonly string[];
}

/**
 * Understands a turn's drafts in order. Each proposal sees the others' named records as said in
 * the turn, and the records the turn's earlier proposals linked as earlier links.
 */
export function understandTurn(
  drafts: readonly ToolProposal[],
  ctx: Omit<UnderstandContext, "turnMentions">,
): TurnUnderstanding {
  const mentions = drafts.map((draft) => draftMention(draft, ctx.utterances));
  let recent = [...ctx.session.recent];
  const proposals: ProposalDraft[] = [];
  const links: LinkDraft[] = [];
  drafts.forEach((draft, index) => {
    const turnMentions = mentions.filter(
      (mention, other): mention is MentionInput => mention !== null && other !== index,
    );
    const proposal = understand(draft, {
      ...ctx,
      session: { ...ctx.session, recent },
      turnMentions,
    });
    if (proposal === null) return;
    proposals.push(proposal);
    links.push({
      mention: linkedMention(proposal.target),
      kinds: TARGET_KINDS[draft.type],
      recent,
      turnMentions,
    });
    recent = withRecentLinks(recent, [proposal]);
  });
  return { proposals, links, recent };
}
