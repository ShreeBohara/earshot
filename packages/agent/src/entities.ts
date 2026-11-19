// Phase 3's entity matching (spec §1 and WP5 step 5): an exact, case-insensitive match of a name
// against the session's entities' names and aliases, and nothing more. Phase 4's linker replaces
// it with candidates, scoring, and abstention.
import type { EntityKind, EntityRef } from "@earshot/core";

function nameKey(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * The one entity of an allowed kind whose name, or failing that whose alias, is `name` once case
 * and spacing are ignored. Null when nothing matches, and when the match is ambiguous: aliases
 * are shared on purpose (three companies answer to "Northwind"), and a write to the wrong record
 * is the worst error, so two candidates mean no target.
 */
export function matchEntity(
  name: string | null,
  entities: readonly EntityRef[],
  kinds: readonly EntityKind[],
): EntityRef | null {
  if (name === null) return null;
  const key = nameKey(name);
  if (key === "") return null;
  const candidates = entities.filter((entity) => kinds.includes(entity.kind));
  const byName = candidates.filter((entity) => nameKey(entity.name) === key);
  if (byName.length > 0) return byName.length === 1 ? (byName[0] ?? null) : null;
  const byAlias = candidates.filter((entity) =>
    entity.aliases.some((alias) => nameKey(alias) === key),
  );
  return byAlias.length === 1 ? (byAlias[0] ?? null) : null;
}
