// The records the confusable-name set links against: the demo CRM as a session holds it
// (`DEMO_SESSION_ENTITIES`, same ids and order), plus each contact's and deal's parent company,
// which Phase 4's `start` carries (spec §4.2). And the ways a rep says each record's name, which
// is what the set's ground truth compares a mention with.
import type { EntityKind, EntityRef } from "@earshot/core";
import { confusables } from "@earshot/demo-crm";
import { DEMO_SESSION_ENTITIES, demoCompanyOf } from "../session";

/** The session's records with parent ids: what WP4's linker indexes. */
export const LINKING_ENTITIES: readonly EntityRef[] = DEMO_SESSION_ENTITIES.map((entity) => {
  const parentId = entity.kind === "company" ? undefined : demoCompanyOf(entity.id);
  return parentId ? { ...entity, parentId } : { ...entity };
});

const BY_ID: ReadonlyMap<string, EntityRef> = new Map(
  LINKING_ENTITIES.map((entity) => [entity.id, entity]),
);

/** A record by id; throws for an id the demo CRM lacks. */
export function linkingEntity(id: string): EntityRef {
  const entity = BY_ID.get(id);
  if (!entity) throw new RangeError(`no demo CRM record ${id}`);
  return entity;
}

export function hasLinkingEntity(id: string): boolean {
  return BY_ID.has(id);
}

/** The company of a contact or deal; a company's own id; undefined for an unknown id. */
export function companyOf(id: string): string | undefined {
  const entity = BY_ID.get(id);
  if (!entity) return undefined;
  return entity.kind === "company" ? entity.id : entity.parentId;
}

export function entitiesOfKind(kind: EntityKind): readonly EntityRef[] {
  return KINDS.get(kind) ?? [];
}

const KINDS: ReadonlyMap<EntityKind, readonly EntityRef[]> = new Map(
  (["company", "contact", "deal"] as const).map((kind) => [
    kind,
    LINKING_ENTITIES.filter((entity) => entity.kind === kind),
  ]),
);

/** The confusable group a company or contact belongs to, or a deal's company does. */
export function groupOf(id: string): string | null {
  const company = BY_ID.get(id)?.kind === "deal" ? companyOf(id) : id;
  return GROUPS.get(company ?? "") ?? null;
}

const GROUPS: ReadonlyMap<string, string> = new Map(
  confusables.flatMap((group) => group.memberIds.map((member) => [member, group.id] as const)),
);

/** The members of a record's confusable group, itself included; just itself outside any group. */
export function groupMembers(id: string): readonly string[] {
  const group = confusables.find((candidate) => candidate.memberIds.includes(id));
  return group ? group.memberIds : [id];
}

/** A deal's name after its company: "Atmos Industrial - Onboarding package" → "Onboarding package". */
export function dealTail(deal: EntityRef): string {
  const company = BY_ID.get(deal.parentId ?? "");
  const prefix = company ? `${company.name} - ` : "";
  if (prefix !== "" && deal.name.startsWith(prefix)) return deal.name.slice(prefix.length);
  const dash = deal.name.indexOf(" - ");
  return dash === -1 ? deal.name : deal.name.slice(dash + 3);
}

/**
 * Every way a rep names a record: a company's name and each alias; a contact's full name; a
 * deal's company name or alias followed by its tail ("Atmos onboarding package"). A rep may stop
 * early ("the Atmos onboarding", "Juniper Bay"), which the ground truth allows by matching a
 * mention against the start of a form.
 */
export function spokenForms(entity: EntityRef): readonly string[] {
  if (entity.kind !== "deal") return [entity.name, ...entity.aliases];
  const company = BY_ID.get(entity.parentId ?? "");
  const tail = dealTail(entity).toLowerCase();
  if (!company) return [entity.name];
  return [company.name, ...company.aliases].map((form) => `${form} ${tail}`);
}

/** The 18 companies in no confusable group: the set's easy negatives, all in class A. */
export const LOOKALIKE_FREE_COMPANIES: readonly string[] = entitiesOfKind("company")
  .filter((entity) => !GROUPS.has(entity.id))
  .map((entity) => entity.id);
