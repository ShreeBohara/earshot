// The debrief generator's phrasings (Phase 4 WP10 step 2): 15 to 25 per proposal type, plus
// phrasings that name no record (the open account stands in) and turns that propose nothing.
//
// Notation (segments.ts): `{M}` is the words that name the target, `{C}` the company said in the
// same breath, and `[field:…]` the words a field quotes. Value slots: `{DUE}` (a due date),
// `{CLOSE}` (a close date), `{DAY}` (a meeting's day), `{TIME}`, `{AMT}`, `{STAGE}`, `{EARLY}`
// (a stage before contract sent), `{ROLE}`, `{EMAIL}`, `{PHONE}`. Word slots: `{doc}`, `{topic}`,
// `{fact}` (a note's clause, `{Fact}` capitalized), `{promise}`, `{role}`.
//
// `values` writes a free-text field the way a model would: `{m}` is the target's words as the
// production stream heard them, `{c}` the company's, and the word slots as filled.
import type { EntityKind, ProposalTypeV2 } from "@earshot/core";

export interface Template {
  /** Stable and unique, for debugging and the ADR's counts. */
  readonly id: string;
  readonly type: ProposalTypeV2;
  /** The kinds of record `{M}` may name. Empty for a phrasing that names none. */
  readonly kinds: readonly EntityKind[];
  readonly text: string;
  /** Free-text fields' values. */
  readonly values?: Readonly<Record<string, string>>;
  /** Whether it reads right for a record the CRM doesn't have yet (default true). */
  readonly forNew?: boolean;
  /** Whether it only reads right for a new record ("New prospect, …"). */
  readonly onlyNew?: boolean;
  /** Whether `{M}` may also be quoted as the commitment's counterpart or the meeting's attendees. */
  readonly personField?: "counterpart" | "attendees";
  /** Whether the template itself says a negation (outside every field). */
  readonly negation?: boolean;
}

const t = (
  id: string,
  type: ProposalTypeV2,
  kinds: readonly EntityKind[],
  text: string,
  extra: Omit<Template, "id" | "type" | "kinds" | "text"> = {},
): Template => ({ id, type, kinds, text, ...extra });

const CO: readonly EntityKind[] = ["company"];
const CT: readonly EntityKind[] = ["contact"];
const DL: readonly EntityKind[] = ["deal"];
const CO_CT: readonly EntityKind[] = ["company", "contact"];
const NONE: readonly EntityKind[] = [];

const body = { body: "{Fact}." };

export const NOTE_TEMPLATES: readonly Template[] = [
  t("note.just_left", "note", CO, "Just left {M}. [body:{Fact}].", { values: body }),
  t("note.quick", "note", CO_CT, "Quick note on {M}: [body:{fact}].", { values: body }),
  t("note.quick_deal", "note", DL, "Quick note on the {M} deal: [body:{fact}].", { values: body }),
  t("note.good_call", "note", CO_CT, "Had a good call with {M} this morning, and [body:{fact}].", {
    values: body,
  }),
  t("note.called_back", "note", CO_CT, "{M} called back, and [body:{fact}].", { values: body }),
  t("note.update_from", "note", CO_CT, "Update from {M}: [body:{fact}].", { values: body }),
  t("note.spoke_from", "note", CT, "Spoke with {M} from {C} today. [body:{Fact}].", {
    values: body,
  }),
  t("note.on_deal", "note", DL, "On the {M} deal, [body:{fact}].", { values: body }),
  t("note.so_for", "note", CO, "So for {M}, [body:{fact}].", { values: body }),
  t("note.met_team", "note", CO, "Met with the team at {M}, and [body:{fact}].", { values: body }),
  t("note.caught_up", "note", CT, "Caught up with {M} over at {C}, and [body:{fact}].", {
    values: body,
  }),
  t("note.heads_up", "note", CO, "Heads up on {M}: [body:{fact}].", { values: body }),
  t("note.mentioned", "note", CT, "{M} mentioned that [body:{fact}].", { values: body }),
  t("note.debrief_from", "note", CO, "Debrief from {M}. [body:{Fact}].", { values: body }),
  t("note.next_steps", "note", CT, "Talked to {M} at {C} about next steps, and [body:{fact}].", {
    values: body,
  }),
  t("note.news_deal", "note", DL, "Some news on the {M} deal: [body:{fact}].", { values: body }),
  t("note.off_phone", "note", CO_CT, "Got off the phone with {M}, and [body:{fact}].", {
    values: body,
  }),
  t("note.says", "note", CT, "For the record, {M} says [body:{fact}].", { values: body }),
  t("note.new_prospect", "note", CO, "New prospect, {M}. [body:{Fact}].", {
    values: body,
    onlyNew: true,
  }),
  t("note.implied_fact", "note", NONE, "[body:{Fact}].", { values: body }),
  t("note.implied_also", "note", NONE, "Also, [body:{fact}].", { values: body }),
  t("note.implied_one_more", "note", NONE, "One more thing, [body:{fact}].", { values: body }),
];

const send = { title: "Send {m} {doc}" };

export const TASK_TEMPLATES: readonly Template[] = [
  t("task.owe", "task", CO_CT, "I owe {M} [title:{doc}] [dueDate:{DUE}].", { values: send }),
  t("task.remind_send", "task", CO_CT, "Remind me to send {M} [title:{doc}] [dueDate:{DUE}].", {
    values: send,
  }),
  t("task.demo", "task", CO, "I need to [title:set up a demo for {M}] [dueDate:{DUE}].", {
    values: { title: "Set up a demo for {m}" },
  }),
  t("task.follow_up", "task", CO_CT, "Follow up with {M} [title:on the {topic}] [dueDate:{DUE}].", {
    values: { title: "Follow up with {m} on the {topic}" },
  }),
  t("task.send_at", "task", CT, "Send {M} at {C} [title:{doc}] [dueDate:{DUE}].", { values: send }),
  t(
    "task.call_about",
    "task",
    CO_CT,
    "I have to [title:call {M} about the {topic}] [dueDate:{DUE}].",
    {
      values: { title: "Call {m} about the {topic}" },
    },
  ),
  t("task.put_together", "task", CO_CT, "Put together [title:{doc} for {M}] [dueDate:{DUE}].", {
    values: { title: "Put together {doc} for {m}" },
  }),
  t(
    "task.add_task",
    "task",
    CO_CT,
    "Can you add a task to [title:get {M} {doc}] [dueDate:{DUE}]?",
    {
      values: { title: "Get {m} {doc}" },
    },
  ),
  t(
    "task.site_visit",
    "task",
    CO_CT,
    "Action item: [title:book a site visit with {M}] [dueDate:{DUE}].",
    {
      values: { title: "Book a site visit with {m}" },
    },
  ),
  t(
    "task.loop_in",
    "task",
    CT,
    "Make sure we [title:loop in {M} on the {topic}] [dueDate:{DUE}].",
    {
      values: { title: "Loop in {m} on the {topic}" },
    },
  ),
  t(
    "task.chase",
    "task",
    DL,
    "I need to [title:chase the signature on the {M} deal] [dueDate:{DUE}].",
    {
      values: { title: "Chase the signature on the {m} deal" },
    },
  ),
  t("task.kickoff", "task", CO_CT, "[title:Schedule the kickoff with {M}] [dueDate:{DUE}].", {
    values: { title: "Schedule the kickoff with {m}" },
  }),
  t("task.next_step", "task", CO_CT, "Next step is to [title:send {M} {doc}] [dueDate:{DUE}].", {
    values: send,
  }),
  t("task.get_over", "task", CO_CT, "Let's [title:get {doc} over to {M}] [dueDate:{DUE}].", {
    values: { title: "Get {doc} over to {m}" },
  }),
  t(
    "task.review_with",
    "task",
    CT,
    "To do: [title:review the {topic} with {M} from {C}] [dueDate:{DUE}].",
    {
      values: { title: "Review the {topic} with {m}" },
    },
  ),
  t(
    "task.walk_through",
    "task",
    CO_CT,
    "I'll need to [title:walk {M} through the {topic}] [dueDate:{DUE}].",
    {
      values: { title: "Walk {m} through the {topic}" },
    },
  ),
  t("task.asked_for", "task", CT, "{M} asked for [title:{doc}] [dueDate:{DUE}].", { values: send }),
  t("task.ping", "task", CT, "Ping {M} over at {C} [title:about the {topic}] [dueDate:{DUE}].", {
    values: { title: "Ping {m} about the {topic}" },
  }),
  t(
    "task.deal_legal",
    "task",
    DL,
    "Follow up on the {M} deal [title:with their legal team] [dueDate:{DUE}].",
    {
      values: { title: "Follow up on the {m} deal with their legal team" },
    },
  ),
  t("task.implied_send", "task", NONE, "Send them [title:{doc}] [dueDate:{DUE}].", {
    values: { title: "Send {doc}" },
  }),
  t("task.implied_need", "task", NONE, "I need to [title:put together {doc}] [dueDate:{DUE}].", {
    values: { title: "Put together {doc}" },
  }),
  t("task.implied_book", "task", NONE, "[title:Book a follow-up call] [dueDate:{DUE}].", {
    values: { title: "Book a follow-up call" },
  }),
];

export const COMMITMENT_TEMPLATES: readonly Template[] = [
  t("commitment.promised", "commitment", CO_CT, "I promised {M} [text:{doc}] [dueDate:{DUE}].", {
    values: { text: "Send {m} {doc}" },
    personField: "counterpart",
  }),
  t(
    "commitment.told",
    "commitment",
    CT,
    "I told {M} we'd [text:send over {doc}] [dueDate:{DUE}].",
    {
      values: { text: "Send {m} {doc}" },
      personField: "counterpart",
    },
  ),
  t(
    "commitment.committed",
    "commitment",
    CO_CT,
    "We committed to [text:getting {M} {doc}] [dueDate:{DUE}].",
    {
      values: { text: "Get {m} {doc}" },
    },
  ),
  t(
    "commitment.word",
    "commitment",
    CT,
    "I gave {M} my word we'd [text:have {doc} ready] [dueDate:{DUE}].",
    {
      values: { text: "Have {doc} ready for {m}" },
      personField: "counterpart",
    },
  ),
  t(
    "commitment.expecting",
    "commitment",
    CO_CT,
    "{M} is expecting [text:{doc}] from us [dueDate:{DUE}].",
    {
      values: { text: "Send {m} {doc}" },
      personField: "counterpart",
    },
  ),
  t(
    "commitment.get_back",
    "commitment",
    CO_CT,
    "I said we'd [text:get back to {M} on the {topic}] [dueDate:{DUE}].",
    {
      values: { text: "Get back to {m} on the {topic}" },
    },
  ),
  t("commitment.owe_at", "commitment", CT, "We owe {M} at {C} [text:{doc}] [dueDate:{DUE}].", {
    values: { text: "Send {m} {doc}" },
    personField: "counterpart",
  }),
  t(
    "commitment.team_at",
    "commitment",
    CO,
    "I promised the team at {M} [text:{doc}] [dueDate:{DUE}].",
    {
      values: { text: "Send {m} {doc}" },
    },
  ),
  t(
    "commitment.fix",
    "commitment",
    CO_CT,
    "We promised {M} we'd [text:fix the {topic} issue] [dueDate:{DUE}].",
    {
      values: { text: "Fix the {topic} issue for {m}" },
      personField: "counterpart",
    },
  ),
  t(
    "commitment.agreed",
    "commitment",
    CT,
    "{M} and I agreed I'd [text:send {doc}] [dueDate:{DUE}].",
    {
      values: { text: "Send {m} {doc}" },
      personField: "counterpart",
    },
  ),
  t(
    "commitment.share",
    "commitment",
    CT,
    "I told {M} over at {C} we'd [text:share {doc}] [dueDate:{DUE}].",
    {
      values: { text: "Share {doc} with {m}" },
      personField: "counterpart",
    },
  ),
  t(
    "commitment.reference",
    "commitment",
    CO_CT,
    "We promised {M} [text:a reference call with a similar customer] [dueDate:{DUE}].",
    {
      values: { text: "Set up a reference call for {m} with a similar customer" },
    },
  ),
  t(
    "commitment.hook",
    "commitment",
    CO_CT,
    "I'm on the hook to [text:deliver {doc} to {M}] [dueDate:{DUE}].",
    {
      values: { text: "Deliver {doc} to {m}" },
    },
  ),
  t(
    "commitment.answer",
    "commitment",
    CO_CT,
    "Promised {M} [text:an answer on the {topic}] [dueDate:{DUE}].",
    {
      values: { text: "Give {m} an answer on the {topic}" },
      personField: "counterpart",
    },
  ),
  t(
    "commitment.counting",
    "commitment",
    CO_CT,
    "{M} is counting on us to [text:send {doc}] [dueDate:{DUE}].",
    {
      values: { text: "Send {m} {doc}" },
    },
  ),
  t(
    "commitment.deal",
    "commitment",
    DL,
    "For the {M} deal, I promised [text:{doc}] [dueDate:{DUE}].",
    {
      values: { text: "Send {doc} for the {m} deal" },
    },
  ),
  t("commitment.promise", "commitment", CO_CT, "I promised {M} [text:{promise}].", {
    values: { text: "{Promise}." },
    personField: "counterpart",
  }),
  t("commitment.implied", "commitment", NONE, "I promised them [text:{doc}] [dueDate:{DUE}].", {
    values: { text: "Send {doc}" },
  }),
  t(
    "commitment.implied_said",
    "commitment",
    NONE,
    "I said we'd [text:send over {doc}] [dueDate:{DUE}].",
    {
      values: { text: "Send over {doc}" },
    },
  ),
];

export const DEAL_TEMPLATES: readonly Template[] = [
  t("deal.move", "deal_update", DL, "Move the {M} deal to [stage:{STAGE}]."),
  t("deal.bump", "deal_update", DL, "Bump the {M} deal to [amount:{AMT}]."),
  t(
    "deal.push_close",
    "deal_update",
    DL,
    "Push the close date on the {M} deal to [closeDate:{CLOSE}].",
  ),
  t(
    "deal.stage_amount",
    "deal_update",
    DL,
    "The {M} deal is now at [stage:{STAGE}], and the number is [amount:{AMT}].",
  ),
  t("deal.moved_today", "deal_update", DL, "{M} moved to [stage:{STAGE}] today."),
  t(
    "deal.update_all",
    "deal_update",
    DL,
    "Update on {M}: [stage:{STAGE}], [amount:{AMT}], closing [closeDate:{CLOSE}].",
  ),
  t("deal.agreed_amount", "deal_update", DL, "We agreed on [amount:{AMT}] for the {M} deal."),
  t("deal.good_news", "deal_update", DL, "Good news on the {M} deal, it's [stage:{STAGE}]."),
  t("deal.went_up", "deal_update", DL, "The {M} number went up to [amount:{AMT}]."),
  t(
    "deal.slipped",
    "deal_update",
    DL,
    "The {M} deal slipped, so the close date is now [closeDate:{CLOSE}].",
  ),
  t("deal.mark", "deal_update", DL, "Mark the {M} deal as [stage:{STAGE}]."),
  t(
    "deal.change_both",
    "deal_update",
    DL,
    "For the {M} deal, change the amount to [amount:{AMT}] and the stage to [stage:{STAGE}].",
  ),
  t(
    "deal.should_close",
    "deal_update",
    DL,
    "The {M} deal should close by [closeDate:{CLOSE}] at [amount:{AMT}].",
  ),
  t("deal.signed", "deal_update", DL, "They signed, so the {M} deal is [stage:closed won]."),
  t("deal.lost", "deal_update", DL, "We lost the {M} deal, so mark it [stage:closed lost]."),
  t(
    "deal.not_yet",
    "deal_update",
    DL,
    "The {M} deal isn't at contract sent yet, it's still at [stage:{EARLY}].",
    {
      negation: true,
    },
  ),
  t(
    "deal.set_close",
    "deal_update",
    DL,
    "Can you set the {M} deal to [amount:{AMT}] and move the close to [closeDate:{CLOSE}]?",
  ),
  t("deal.revised", "deal_update", DL, "Revised pricing for the {M} deal: [amount:{AMT}]."),
  t(
    "deal.sent_contract",
    "deal_update",
    DL,
    "Sent the paperwork for the {M} deal, so move it to [stage:contract sent].",
  ),
  t("deal.implied_move", "deal_update", NONE, "Move the deal to [stage:{STAGE}]."),
  t("deal.implied_bump", "deal_update", NONE, "Bump the deal to [amount:{AMT}]."),
  t(
    "deal.implied_close",
    "deal_update",
    NONE,
    "Push the close date on the deal to [closeDate:{CLOSE}].",
  ),
];

export const MEETING_TEMPLATES: readonly Template[] = [
  t(
    "meeting.call",
    "meeting",
    CO_CT,
    "Set up a call with {M} [date:{DAY}] [time:{TIME}] to [title:go over the {topic}].",
    {
      values: { title: "Call with {m} to go over the {topic}" },
      personField: "attendees",
    },
  ),
  t(
    "meeting.qbr",
    "meeting",
    CO_CT,
    "We're meeting {M} [date:{DAY}] [time:{TIME}] for [title:the quarterly business review].",
    {
      values: { title: "Quarterly business review with {m}" },
      personField: "attendees",
    },
  ),
  t(
    "meeting.demo",
    "meeting",
    CO_CT,
    "Booked [title:a demo] with {M} [date:{DAY}] [time:{TIME}].",
    {
      values: { title: "Demo with {m}" },
      personField: "attendees",
    },
  ),
  t("meeting.site_visit", "meeting", CO_CT, "{M} wants [title:a site visit] [date:{DAY}].", {
    values: { title: "Site visit with {m}" },
  }),
  t(
    "meeting.lunch",
    "meeting",
    CT,
    "Lunch with {M} [date:{DAY}] [time:{TIME}] to [title:talk about the {topic}].",
    {
      values: { title: "Lunch with {m} about the {topic}" },
      personField: "attendees",
    },
  ),
  t(
    "meeting.kickoff",
    "meeting",
    CO_CT,
    "Put [title:a kickoff meeting] on the calendar with {M} [date:{DAY}] [time:{TIME}].",
    {
      values: { title: "Kickoff meeting with {m}" },
      personField: "attendees",
    },
  ),
  t(
    "meeting.pricing",
    "meeting",
    CT,
    "Schedule [title:a pricing review] with [attendees:{M} and their {role}] [date:{DAY}].",
    {
      values: { title: "Pricing review with {m}", attendees: "{m} and their {role}" },
    },
  ),
  t(
    "meeting.workshop",
    "meeting",
    CO_CT,
    "{M} agreed to [title:a workshop on the {topic}] [date:{DAY}] [time:{TIME}].",
    {
      values: { title: "Workshop on the {topic} with {m}" },
    },
  ),
  t(
    "meeting.follow_up",
    "meeting",
    CT,
    "We have [title:a follow-up call] with {M} from {C} [date:{DAY}] [time:{TIME}].",
    {
      values: { title: "Follow-up call with {m}" },
      personField: "attendees",
    },
  ),
  t(
    "meeting.team",
    "meeting",
    CO,
    "Meeting with the team at {M} [date:{DAY}] [time:{TIME}] about [title:the {topic}].",
    {
      values: { title: "Meeting with {m} about the {topic}" },
    },
  ),
  t(
    "meeting.walkthrough",
    "meeting",
    CO_CT,
    "Calendar this: [title:a contract walkthrough] with {M}, [date:{DAY}] [time:{TIME}].",
    {
      values: { title: "Contract walkthrough with {m}" },
      personField: "attendees",
    },
  ),
  t(
    "meeting.deep_dive",
    "meeting",
    CT,
    "{M} can do [title:a technical deep dive] [date:{DAY}] [time:{TIME}].",
    {
      values: { title: "Technical deep dive with {m}" },
    },
  ),
  t("meeting.onsite", "meeting", CO, "I set up [title:an onsite visit] at {M} [date:{DAY}].", {
    values: { title: "Onsite visit at {m}" },
  }),
  t(
    "meeting.over_at",
    "meeting",
    CT,
    "Let's get [title:a call] going with {M} over at {C} [date:{DAY}] [time:{TIME}].",
    {
      values: { title: "Call with {m}" },
      personField: "attendees",
    },
  ),
  t(
    "meeting.briefing",
    "meeting",
    CO_CT,
    "Booked [title:the executive briefing] with {M} [date:{DAY}] [time:{TIME}].",
    {
      values: { title: "Executive briefing with {m}" },
      personField: "attendees",
    },
  ),
  t(
    "meeting.renewal",
    "meeting",
    CT,
    "{M} and I are doing [title:a renewal review] [date:{DAY}] [time:{TIME}].",
    {
      values: { title: "Renewal review with {m}" },
    },
  ),
  t(
    "meeting.deal_review",
    "meeting",
    DL,
    "Set up [title:a deal review] for the {M} deal [date:{DAY}] [time:{TIME}].",
    {
      values: { title: "Deal review for the {m} deal" },
    },
  ),
  t(
    "meeting.implied_visit",
    "meeting",
    NONE,
    "We're doing [title:a site visit] [date:{DAY}] [time:{TIME}].",
    {
      values: { title: "Site visit" },
    },
  ),
  t(
    "meeting.implied_call",
    "meeting",
    NONE,
    "Booked [title:a kickoff call] [date:{DAY}] [time:{TIME}].",
    {
      values: { title: "Kickoff call" },
    },
  ),
];

export const CONTACT_TEMPLATES: readonly Template[] = [
  t("contact.new_role_at", "contact", CT, "[name:{M}] is the new [title:{ROLE}] at [company:{C}]."),
  t(
    "contact.met_from",
    "contact",
    CT,
    "Met [name:{M}] from [company:{C}], they're the [title:{ROLE}].",
  ),
  t("contact.add", "contact", CT, "Add [name:{M}], [title:{ROLE}] at [company:{C}]."),
  t("contact.email", "contact", CT, "[name:{M}]'s email is [email:{EMAIL}]."),
  t(
    "contact.new_phone",
    "contact",
    CT,
    "New contact: [name:{M}], [title:{ROLE}], phone [phone:{PHONE}].",
    {
      onlyNew: true,
    },
  ),
  t("contact.moved_role", "contact", CT, "[name:{M}] moved into the [title:{ROLE}] role.", {
    forNew: false,
  }),
  t("contact.update_title", "contact", CT, "Update the title for [name:{M}] to [title:{ROLE}].", {
    forNew: false,
  }),
  t(
    "contact.taking_over",
    "contact",
    CT,
    "[name:{M}] from [company:{C}] is taking over as [title:{ROLE}].",
  ),
  t("contact.reach", "contact", CT, "You can reach [name:{M}] at [phone:{PHONE}]."),
  t(
    "contact.got_new",
    "contact",
    CT,
    "Got a new contact, [name:{M}], the [title:{ROLE}] over at [company:{C}].",
    {
      onlyNew: true,
    },
  ),
  t(
    "contact.joined",
    "contact",
    CT,
    "[name:{M}] just joined [company:{C}] as their [title:{ROLE}].",
    {
      onlyNew: true,
    },
  ),
  t(
    "contact.their_new",
    "contact",
    CT,
    "[company:{C}] has a new [title:{ROLE}], [name:{M}], and the email is [email:{EMAIL}].",
    {
      onlyNew: true,
    },
  ),
  t("contact.is_now", "contact", CT, "[name:{M}] is now [title:{ROLE}].", { forNew: false }),
  t(
    "contact.please_add",
    "contact",
    CT,
    "Please add [name:{M}] from [company:{C}], number [phone:{PHONE}].",
    {
      onlyNew: true,
    },
  ),
  t(
    "contact.who_is",
    "contact",
    CT,
    "I met [name:{M}], who's the [title:{ROLE}] at [company:{C}].",
  ),
  t("contact.new_number", "contact", CT, "[name:{M}]'s new number is [phone:{PHONE}].", {
    forNew: false,
  }),
  t("contact.new_email", "contact", CT, "[name:{M}] has a new email, [email:{EMAIL}].", {
    forNew: false,
  }),
];

export const TEMPLATES: Readonly<Record<ProposalTypeV2, readonly Template[]>> = {
  note: NOTE_TEMPLATES,
  task: TASK_TEMPLATES,
  commitment: COMMITMENT_TEMPLATES,
  deal_update: DEAL_TEMPLATES,
  meeting: MEETING_TEMPLATES,
  contact: CONTACT_TEMPLATES,
};

/** A turn that proposes nothing. `{M}` is the account the debrief is about; `{S}` a sibling. */
export interface QuietTemplate {
  readonly id: string;
  readonly text: string;
  /** Says a negation: tagged `negation`. */
  readonly negation: boolean;
}

export const QUIET_TEMPLATES: readonly QuietTemplate[] = [
  { id: "quiet.all_for", text: "That's all for {M}.", negation: false },
  { id: "quiet.it_for", text: "That's it for {M} today.", negation: false },
  { id: "quiet.everything", text: "Okay, that's everything on {M}.", negation: false },
  { id: "quiet.wraps", text: "That wraps up {M}.", negation: false },
  { id: "quiet.debrief", text: "That's the debrief for today.", negation: false },
];

export const NEGATED_QUIET_TEMPLATES: readonly QuietTemplate[] = [
  {
    id: "quiet.confused",
    text: "Not to be confused with {S}, which is a different account.",
    negation: true,
  },
  { id: "quiet.mix", text: "Don't mix them up with {S}.", negation: true },
  { id: "quiet.separate", text: "{S} is a separate account, so no changes there.", negation: true },
  {
    id: "quiet.didnt_talk",
    text: "I didn't talk to {S} this week, so there's no update there.",
    negation: true,
  },
  { id: "quiet.nothing", text: "Nothing changes for {S} today.", negation: true },
  { id: "quiet.not_touching", text: "I'm not touching the {S} account today.", negation: true },
];
