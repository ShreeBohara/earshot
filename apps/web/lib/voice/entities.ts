// The CRM records a session may mention, as POST /api/sessions hands them to the client, which
// sends them back to SessionDO unchanged in `start`. That message may carry at most 250 entities
// and 64 KiB of UTF-8 (@earshot/core), and with long names or many aliases the byte cap binds
// first, so the list is budgeted by its serialized size as well as its length.
import {
  containsKeyShape,
  type EntityRef,
  MAX_ENTITY_ALIASES,
  MAX_ENTITY_NAME_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_SESSION_ENTITIES,
  type SessionProviders,
} from "@earshot/core";
import type { CrmEntity } from "./keyterms";

/**
 * Bytes of `start` held back for a client that spells its own fields longer than the envelope
 * below does: `startedAt` with microseconds and an offset, say.
 */
export const START_SLACK_BYTES = 512;
/** The longest entity id the session socket accepts. */
const MAX_ENTITY_ID_CHARS = 128;

const encoder = new TextEncoder();

export function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * How many bytes of `start` are left for the items of its `entities` array (with the commas
 * between them), once the rest of the message is written with `providers`, the providers the
 * client named when it created the session and will send again.
 */
export function startEntityBudget(providers: SessionProviders): number {
  const envelope = {
    t: "start",
    msgId: "01a1c6e2-9320-7deb-a57a-ba62dc02df02",
    mode: "debrief",
    engine: "cascaded",
    providers,
    startedAt: "2026-11-15T19:15:00.000Z",
    entities: [],
  };
  return MAX_MESSAGE_BYTES - utf8Length(JSON.stringify(envelope)) - START_SLACK_BYTES;
}

/**
 * Up to 250 entities from `ranked`, in order, whose JSON fits in `budgetBytes`. One that doesn't
 * fit is skipped, so a record with long aliases can't crowd out every smaller one after it. Rows
 * the socket would refuse are dropped (`toEntityRef`).
 */
export function sessionEntities(ranked: readonly CrmEntity[], budgetBytes: number): EntityRef[] {
  const entities: EntityRef[] = [];
  let used = 0;
  for (const row of ranked) {
    if (entities.length === MAX_SESSION_ENTITIES) break;
    const ref = toEntityRef(row);
    if (!ref) continue;
    const cost = utf8Length(JSON.stringify(ref)) + (entities.length > 0 ? 1 : 0);
    if (used + cost > budgetBytes) continue;
    entities.push(ref);
    used += cost;
  }
  return entities;
}

/**
 * A row as the session socket accepts it: the name trimmed and at most 200 characters, at most
 * 20 distinct aliases that fit the same rule, and an id of at most 128 characters. A row whose
 * name or id can't be sent is dropped, and so is any alias that can't. So is anything shaped like
 * a provider key: SessionDO refuses a `start` holding one, and the session wouldn't start.
 */
export function toEntityRef(
  row: Pick<CrmEntity, "id" | "kind" | "name" | "aliases">,
): EntityRef | undefined {
  const name = row.name.trim();
  if (!sendable(name, MAX_ENTITY_NAME_CHARS) || !sendable(row.id, MAX_ENTITY_ID_CHARS)) {
    return undefined;
  }
  const seen = new Set([name.toLowerCase()]);
  const aliases: string[] = [];
  for (const raw of row.aliases) {
    if (aliases.length === MAX_ENTITY_ALIASES) break;
    const alias = raw.trim();
    const folded = alias.toLowerCase();
    if (!sendable(alias, MAX_ENTITY_NAME_CHARS) || seen.has(folded)) continue;
    seen.add(folded);
    aliases.push(alias);
  }
  return { id: row.id, kind: row.kind, name, aliases };
}

function sendable(text: string, maxChars: number): boolean {
  return text.length > 0 && text.length <= maxChars && !containsKeyShape(text);
}
