// The words the debrief generator fills its templates with (Phase 4 WP10 step 2). Everything here
// is invented and generic, like the demo CRM: no real company, product, or person.
//
// What the lists must never hold, because the ground truth reads it:
// - a negation word (not, no, never, without, a "n't" contraction…) outside `NEGATED_FACTS`, so
//   a turn is tagged `negation` exactly when a template put one there;
// - a correction marker (sorry, actually, rather, "I mean", "no wait", "make that", "scratch
//   that", "correction"), so a turn is tagged `self_correction` exactly when one was inserted;
// - a weekday, a month name, or a digit, so a date or amount the ground truth quotes is the first
//   of its words in the turn (a self-correction's quote must be);
// - a filler (um, uh, er, "you know"), so `disfluency` is tagged exactly when one was inserted.
// A test checks the lists against these rules.

/** Things a rep sends or delivers: a task's or commitment's object. */
export const DOCS = [
  "the updated pricing",
  "a revised quote",
  "the security questionnaire",
  "a couple of customer references",
  "the order form",
  "the rollout plan",
  "the integration guide",
  "a pilot proposal",
  "the renewal terms",
  "the case study",
  "the implementation timeline",
  "the redlined contract",
  "a draft statement of work",
  "the onboarding checklist",
  "the training schedule",
  "the ROI model",
  "the data processing agreement",
  "the reference architecture",
  "the support plan",
  "the product roadmap deck",
  "the migration plan",
  "the invoice breakdown",
] as const;

/** Things a meeting or a follow-up is about. */
export const TOPICS = [
  "renewal terms",
  "security review",
  "rollout timeline",
  "integration",
  "pilot results",
  "support contract",
  "pricing tiers",
  "data migration",
  "onboarding plan",
  "invoice dispute",
  "procurement process",
  "reporting setup",
  "single sign-on setup",
  "training plan",
  "expansion plan",
  "legal review",
] as const;

/** What a note records: a clause about the account, in its own words. */
export const FACTS = [
  "they want to expand the rollout to two more sites",
  "they're reviewing the proposal with legal this week",
  "the pilot is going well and they want a formal quote",
  "procurement wants a three-year term",
  "they're comparing us with two other vendors",
  "their IT team flagged the single sign-on setup",
  "they want the integration live before the holidays",
  "the budget is approved for next quarter",
  "they asked for a case study from a similar customer",
  "their CFO wants to see the ROI model",
  "the security review passed",
  "they loved the new reporting dashboard",
  "they're consolidating vendors next year",
  "our champion is moving to a new role",
  "they need their data to stay in the EU",
  "support tickets have dropped since the upgrade",
  "they want weekly check-ins during onboarding",
  "the rollout slipped because of a hiring freeze",
  "they're happy with the pricing but want better payment terms",
  "their operations team is pushing hard for this",
  "they want to add the analytics module",
  "the new VP of operations is our sponsor now",
] as const;

/**
 * Notes that carry a negation inside the quoted clause: each has a trigger the product's
 * NegEx-style check reads, so the body field should be flagged `negation`.
 */
export const NEGATED_FACTS = [
  "they won't sign before the budget review",
  "they're not renewing the support add-on",
  "procurement doesn't want a multi-year term",
  "they can't move forward without a security review",
  "the pilot isn't covering the warehouse sites",
  "they never got the updated pricing",
  "nobody on their side has seen the contract yet",
  "they don't need the analytics module this year",
  "they're no longer looking at other vendors",
  "legal hasn't approved the data processing terms",
] as const;

/** Promises that carry a negation inside the quoted clause. */
export const NEGATED_PROMISES = [
  "we won't raise prices before the renewal",
  "we won't charge for the extra seats",
  "their data never leaves their region",
  "the migration won't need any downtime",
] as const;

/** Job titles, as a rep says them. */
export const ROLES = [
  "procurement lead",
  "head of IT",
  "operations director",
  "VP of finance",
  "IT lead",
  "supply chain director",
  "general manager",
  "controller",
  "head of operations",
  "managing director",
  "facilities manager",
  "plant manager",
  "chief of staff",
  "security lead",
  "data team lead",
  "finance director",
  "head of customer success",
  "director of engineering",
] as const;

/** The demo CRM's deal stages, as a rep says them (`DEAL_STAGES` in @earshot/demo-crm). */
export const STAGES = [
  "appointment scheduled",
  "qualified to buy",
  "presentation scheduled",
  "decision maker bought in",
  "contract sent",
  "closed won",
  "closed lost",
] as const;

/** Stages a deal can be "still at" when it isn't at contract sent yet. */
export const EARLY_STAGES = [
  "appointment scheduled",
  "qualified to buy",
  "presentation scheduled",
  "decision maker bought in",
] as const;

/** New people a rep might add: invented names that sound like no demo contact. */
export const NEW_PEOPLE = [
  "Talia Brooks",
  "Desmond Okoro",
  "Ilse Varga",
  "Mateus Ferraz",
  "Rhiannon Price",
  "Kofi Mensah",
  "Linnea Sjoberg",
  "Dario Conti",
  "Yasmin Haddad",
  "Bram de Vries",
  "Nkechi Obi",
  "Tomasz Wrona",
] as const;

/** Hesitations a stream transcribes (LARD's interregnums, and plain fillers). */
export const FILLERS = ["um", "uh", "you know"] as const;

/** Function words a speaker swaps for another and repairs (LARD's replacements). */
export const REPLACEMENTS: Readonly<Record<string, readonly string[]>> = {
  the: ["a", "this"],
  to: ["for", "with"],
  for: ["to", "with"],
  with: ["to", "for"],
  about: ["on", "for"],
  on: ["at", "about"],
  at: ["with", "on"],
};

/** The rep's time zones, by weight. */
export const TIME_ZONES: Readonly<Record<string, number>> = {
  "America/New_York": 0.3,
  "America/Chicago": 0.25,
  "America/Denver": 0.1,
  "America/Los_Angeles": 0.25,
  "Europe/London": 0.1,
};

/** Background noise, by weight, and the SNRs a noisy script draws from. */
export const NOISE_WEIGHTS = { none: 0.4, car: 0.2, street: 0.2, cafe: 0.2 } as const;
export const NOISE_SNRS = [0, 5, 10, 15, 20] as const;
