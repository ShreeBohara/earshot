import { z } from "zod";

export const CONFUSION_TYPES = ["spelling", "phonetic", "shared-stem", "abbreviation"] as const;
export const DEAL_STAGES = [
  "appointmentscheduled",
  "qualifiedtobuy",
  "presentationscheduled",
  "decisionmakerboughtin",
  "contractsent",
  "closedwon",
  "closedlost",
] as const;
export const ACTIVITY_TYPES = ["note", "task", "meeting"] as const;
export const TASK_STATUSES = ["open", "completed"] as const;

const exampleDomain = z.string().regex(/^[a-z0-9-]+\.example$/, "must be a .example domain");
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime();

export const Company = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  domain: exampleDomain,
  industry: z.string().min(1),
  size: z.string().min(1),
  city: z.string().min(1),
  aliases: z.array(z.string().min(1)),
});
export type Company = z.infer<typeof Company>;

export const Contact = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  title: z.string().min(1),
  email: z.email().regex(/@[a-z0-9-]+\.example$/, "must be on a .example domain"),
  phone: z.string().regex(/^555-01\d{2}$/, "must be in the 555-01xx range"),
});
export type Contact = z.infer<typeof Contact>;

export const DealStage = z.enum(DEAL_STAGES);
export type DealStage = z.infer<typeof DealStage>;

export const Deal = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  name: z.string().min(1),
  /** USD. */
  amount: z.number().int().positive(),
  stage: DealStage,
  closeDate: isoDate,
  ownerContactId: z.string().min(1),
});
export type Deal = z.infer<typeof Deal>;

export const Activity = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  contactId: z.string().min(1).optional(),
  type: z.enum(ACTIVITY_TYPES),
  subject: z.string().min(1),
  body: z.string().min(1),
  at: isoDateTime,
  /** Tasks only. */
  dueAt: isoDateTime.optional(),
  /** Tasks only. */
  status: z.enum(TASK_STATUSES).optional(),
});
export type Activity = z.infer<typeof Activity>;

export const ConfusableGroup = z.object({
  id: z.string().min(1),
  kind: z.enum(["company", "contact"]),
  confusion: z.enum(CONFUSION_TYPES),
  /** Ids of the companies or contacts that sound or look alike. */
  memberIds: z.array(z.string().min(1)).min(2),
});
export type ConfusableGroup = z.infer<typeof ConfusableGroup>;

export const CrmEntityKind = z.enum(["company", "contact", "deal", "activity"]);
export type CrmEntityKind = z.infer<typeof CrmEntityKind>;

/** One row in the shape of the future `crm_entities` table. */
export const CrmEntityRow = z.object({
  kind: CrmEntityKind,
  externalId: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()),
  properties: z.record(z.string(), z.unknown()),
});
export type CrmEntityRow = z.infer<typeof CrmEntityRow>;

export type CrmDataset = {
  companies: Company[];
  contacts: Contact[];
  deals: Deal[];
  activities: Activity[];
  confusables: ConfusableGroup[];
};
