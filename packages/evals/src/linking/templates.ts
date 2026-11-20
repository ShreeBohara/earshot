// The carrier sentences a mention is said in: one turn of a debrief, the words around a name. Only
// the mention and the company said with it vary between the two witnesses, so the rest of the
// sentence is the same in both transcripts.
import type { EntityKind, ProposalType } from "@earshot/core";
import type { Rng } from "../channel/rng";
import type { Span } from "./schema";

export interface Template {
  readonly type: ProposalType;
  readonly kind: EntityKind;
  /** `{M}` is the mention; `{C}`, if present, the company said in the same breath. */
  readonly text: string;
  /** Whether it reads right for a record the CRM doesn't have yet. */
  readonly forNew: boolean;
}

const t = (type: ProposalType, kind: EntityKind, text: string, forNew = true): Template => ({
  type,
  kind,
  text,
  forNew,
});

export const TEMPLATES: readonly Template[] = [
  t("note", "company", "Quick note on {M}: they're reviewing the proposal with legal this week."),
  t("note", "company", "Just got off a call with {M}, and they want a revised quote by Friday."),
  t("note", "company", "{M} is pushing the kickoff back to next month."),
  t("note", "company", "Spoke with the team at {M} about the renewal terms.", false),
  t("note", "company", "Good meeting with {M} today, they liked the security review."),
  t("task", "company", "Remind me to send {M} the updated pricing by Friday."),
  t("task", "company", "I need to set up a demo for {M} next week."),
  t(
    "task",
    "company",
    "Put together a renewal proposal for {M} before the end of the month.",
    false,
  ),
  t("commitment", "company", "I promised {M} we'd have the integration plan to them by Monday."),
  t("commitment", "company", "We told {M} they'd get a reference call this week."),

  t("note", "contact", "Had a good call with {M} this morning, and the pilot is on track."),
  t("note", "contact", "{M} says the budget is approved for next quarter."),
  t("note", "contact", "Caught up with {M} about the security questionnaire."),
  t(
    "note",
    "contact",
    "Had a good call with {M} from {C} this morning, and the pilot is on track.",
  ),
  t("note", "contact", "{M} at {C} says the budget is approved for next quarter."),
  t("note", "contact", "Caught up with {M} over at {C} about the security questionnaire."),
  t("task", "contact", "Follow up with {M} on the contract by Thursday."),
  t("task", "contact", "Send {M} the case study tomorrow."),
  t("task", "contact", "Follow up with {M} at {C} on the contract by Thursday."),
  t("task", "contact", "Send {M} from {C} the case study tomorrow."),
  t("commitment", "contact", "I told {M} we'd send over two references this week."),
  t("commitment", "contact", "I told {M} at {C} we'd send over two references this week."),
  t("contact", "contact", "{M} is taking over procurement, so they're our main contact now."),
  t("contact", "contact", "{M} moved into the operations director role.", false),
  t("contact", "contact", "Update the title for {M} to VP of finance.", false),
  t("contact", "contact", "{M} from {C} is the new procurement lead."),
  t("contact", "contact", "Met {M} from {C} at the conference, and they run IT there."),
  t("contact", "contact", "{M} at {C} is now heading up operations."),

  t("note", "deal", "The {M} deal is waiting on procurement."),
  t("note", "deal", "Some movement on the {M} deal, legal has the redlines."),
  t("task", "deal", "Chase the signature on the {M} deal before the end of the month."),
  t("commitment", "deal", "I committed to getting the {M} paperwork out by Friday."),
  t("deal_update", "deal", "The {M} deal moved to contract sent."),
  t("deal_update", "deal", "Push the close date on the {M} deal to March."),
  t("deal_update", "deal", "Bump the {M} deal to sixty thousand."),
  t("deal_update", "deal", "The {M} deal is now at decision maker bought in."),
];

/** A carrier for a mention: of its type and kind, with a company slot exactly when one is said. */
export function pickTemplate(
  rng: Rng,
  type: ProposalType,
  kind: EntityKind,
  withCompany: boolean,
  isNew: boolean,
): Template {
  const options = TEMPLATES.filter(
    (template) =>
      template.type === type &&
      template.kind === kind &&
      template.text.includes("{C}") === withCompany &&
      (template.forNew || !isNew),
  );
  return rng.pick(options);
}

/** A template with its slots filled, and where each filled slot sits. */
export function fillTemplate(
  template: Template,
  mention: string,
  company: string | null,
): { transcript: string; mention: Span; company: Span | null } {
  let transcript = "";
  let mentionSpan: Span | null = null;
  let companySpan: Span | null = null;
  for (const part of template.text.split(/(\{[MC]\})/)) {
    if (part === "{M}") {
      mentionSpan = {
        start: transcript.length,
        end: transcript.length + mention.length,
        text: mention,
      };
      transcript += mention;
    } else if (part === "{C}") {
      if (company === null) throw new Error(`template needs a company: ${template.text}`);
      companySpan = {
        start: transcript.length,
        end: transcript.length + company.length,
        text: company,
      };
      transcript += company;
    } else {
      transcript += part;
    }
  }
  if (mentionSpan === null) throw new Error(`template has no mention: ${template.text}`);
  return { transcript, mention: mentionSpan, company: companySpan };
}
