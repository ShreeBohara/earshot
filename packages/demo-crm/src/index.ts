import activitiesJson from "../data/activities.json" with { type: "json" };
import companiesJson from "../data/companies.json" with { type: "json" };
import confusablesJson from "../data/confusables.json" with { type: "json" };
import contactsJson from "../data/contacts.json" with { type: "json" };
import dealsJson from "../data/deals.json" with { type: "json" };
import {
  Activity,
  Company,
  ConfusableGroup,
  Contact,
  type CrmDataset,
  type CrmEntityRow,
  Deal,
} from "./schemas";

export * from "./schemas";

export const companies: Company[] = Company.array().parse(companiesJson);
export const contacts: Contact[] = Contact.array().parse(contactsJson);
export const deals: Deal[] = Deal.array().parse(dealsJson);
export const activities: Activity[] = Activity.array().parse(activitiesJson);
export const confusables: ConfusableGroup[] = ConfusableGroup.array().parse(confusablesJson);

/**
 * Flattens a dataset into `crm_entities` rows: companies, contacts, and deals, in that order.
 * `name` is what a rep would say aloud; `properties` carries everything else. Activities are
 * history rather than records a rep links an update to, so they stay out of `crm_entities`
 * (its kind check allows only these three); use `activities` directly.
 */
export function toEntityRows(
  data: Pick<CrmDataset, "companies" | "contacts" | "deals"> = { companies, contacts, deals },
): CrmEntityRow[] {
  const rows: CrmEntityRow[] = [];
  for (const { id, name, aliases, ...properties } of data.companies) {
    rows.push({ kind: "company", externalId: id, name, aliases, properties });
  }
  for (const { id, firstName, lastName, ...properties } of data.contacts) {
    rows.push({
      kind: "contact",
      externalId: id,
      name: `${firstName} ${lastName}`,
      aliases: [],
      properties: { firstName, lastName, ...properties },
    });
  }
  for (const { id, name, ...properties } of data.deals) {
    rows.push({ kind: "deal", externalId: id, name, aliases: [], properties });
  }
  return rows;
}
