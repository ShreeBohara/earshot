import { z } from "zod";

/** The CRM record kinds Earshot mirrors: the same three as the `crm_entities_kind_check` constraint. */
export const EntityKind = z.enum(["company", "contact", "deal"]);
export type EntityKind = z.infer<typeof EntityKind>;

/**
 * A CRM record a session may mention: what the web app hands the client and the client hands
 * `SessionDO` in `start`, and what extraction matches names against. Phase 3 matches only exact
 * names and aliases, ignoring case; Phase 4's entity linker resolves names by sound, spelling,
 * and context, including each record's parent. The session socket caps the lengths
 * (`MAX_ENTITY_NAME_CHARS`, `MAX_ENTITY_ALIASES`, `MAX_ENTITY_ID_CHARS`); this contract doesn't,
 * because Zod counts a string's length in UTF-16 code units and JSON Schema in code points.
 */
export const EntityRef = z
  .strictObject({
    /** The record's id in the workspace's CRM mirror. A proposal names it as `targetEntityId`. */
    id: z.string().min(1),
    kind: EntityKind,
    name: z.string().min(1),
    /** Other names the record goes by, for example `Acme` for `Acme Corp`. */
    aliases: z.array(z.string().min(1)),
    /**
     * The id of the record's parent in the same mirror: the company of a contact or deal. Absent
     * when the record has none, or the mirror doesn't know it.
     */
    parentId: z.string().min(1).optional(),
  })
  .meta({
    title: "EntityRef",
    description:
      "A CRM record a session may mention: its id, kind, name, aliases, and parent record.",
  });
export type EntityRef = z.infer<typeof EntityRef>;
