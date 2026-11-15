import { EventEnvelope, eventPayloadContracts } from "@earshot/core";
import type { z } from "zod";
import { describeEvent, EventValidationError, UnknownEventError, UpcastError } from "./errors";
import type { PayloadDefinition, SessionEvent, Upcaster } from "./types";
import { upcasters } from "./upcasters";

/**
 * Maps each `(type, schemaVersion)` to its payload schema, and chains upcasters so that any stored
 * event can be moved to the latest version of its type.
 */
export interface EventRegistry<E extends EventEnvelope = EventEnvelope> {
  /** The newest schema version registered for `type`, or `undefined` for an unknown type. */
  latestVersion(type: string): number | undefined;
  /** The payload schema for one `(type, schemaVersion)`, or `undefined`. */
  payloadSchema(type: string, schemaVersion: number): z.ZodType | undefined;
  /** Checks an event's payload against the schema for its own type and version, and returns it. */
  validate(event: EventEnvelope): EventEnvelope;
  /** Applies upcasters, one version at a time, until the event reaches the latest version. */
  upcast(event: EventEnvelope): EventEnvelope;
  /** Validates the event at its own version, upcasts it, and validates the result at the latest. */
  toLatest(event: EventEnvelope): E;
}

/**
 * Checks `input` against `EventEnvelope` and returns it unchanged, so a caller keeps the exact
 * object (and key order) it passed in. `where` prefixes the error message, for example `event 3`.
 */
export function parseEnvelope(input: unknown, where?: string): EventEnvelope {
  const result = EventEnvelope.safeParse(input);
  if (!result.success) {
    const subject = where ? `${where}: invalid event envelope` : "invalid event envelope";
    throw new EventValidationError(subject, result.error.issues);
  }
  return input as EventEnvelope;
}

/**
 * Builds a registry. It fails fast on a duplicate `(type, schemaVersion)`, on an upcaster for a
 * version that isn't registered, and on any version below the latest that has no upcaster, so
 * a broken chain shows up when the module loads rather than when an old event is replayed.
 */
export function createEventRegistry<E extends EventEnvelope = EventEnvelope>(options: {
  payloads: readonly PayloadDefinition[];
  upcasters?: readonly Upcaster[];
}): EventRegistry<E> {
  const schemas = new Map<string, Map<number, z.ZodType>>();
  for (const { type, schemaVersion, schema } of options.payloads) {
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
      throw new RangeError(`${type}: schema versions are positive integers, got ${schemaVersion}`);
    }
    const versions = schemas.get(type) ?? new Map<number, z.ZodType>();
    if (versions.has(schemaVersion)) {
      throw new Error(`${type} v${schemaVersion} is registered twice`);
    }
    versions.set(schemaVersion, schema);
    schemas.set(type, versions);
  }

  const chain = new Map<string, Upcaster>();
  for (const upcaster of options.upcasters ?? []) {
    const { type, fromVersion } = upcaster;
    const key = upcasterKey(type, fromVersion);
    if (chain.has(key)) throw new Error(`${type} v${fromVersion} has two upcasters`);
    const versions = schemas.get(type);
    if (!versions?.has(fromVersion) || !versions.has(fromVersion + 1)) {
      throw new UpcastError(
        `the ${type} v${fromVersion} upcaster needs schemas for v${fromVersion} and v${fromVersion + 1}`,
      );
    }
    chain.set(key, upcaster);
  }

  const latest = new Map<string, number>();
  for (const [type, versions] of schemas) {
    const newest = Math.max(...versions.keys());
    for (const version of versions.keys()) {
      if (version < newest && !chain.has(upcasterKey(type, version))) {
        throw new UpcastError(`${type} v${version} has no upcaster to v${version + 1}`);
      }
    }
    latest.set(type, newest);
  }

  function schemaFor(event: EventEnvelope): z.ZodType {
    const newest = latest.get(event.type);
    if (newest === undefined) throw new UnknownEventError(event, "unknown event type");
    const schema = schemas.get(event.type)?.get(event.schemaVersion);
    if (schema) return schema;
    throw new UnknownEventError(
      event,
      event.schemaVersion > newest
        ? `newer than this reader knows (latest is v${newest})`
        : "no schema for this version",
    );
  }

  function validate(event: EventEnvelope): EventEnvelope {
    const result = schemaFor(event).safeParse(event.payload);
    if (!result.success) {
      throw new EventValidationError(
        `${describeEvent(event)}: invalid payload`,
        result.error.issues,
      );
    }
    return event;
  }

  function upcast(event: EventEnvelope): EventEnvelope {
    const newest = latest.get(event.type);
    if (newest === undefined) throw new UnknownEventError(event, "unknown event type");
    if (event.schemaVersion > newest) {
      throw new UnknownEventError(event, `newer than this reader knows (latest is v${newest})`);
    }
    let current = event;
    while (current.schemaVersion < newest) {
      const upcaster = chain.get(upcasterKey(current.type, current.schemaVersion));
      if (!upcaster) throw new UpcastError(`${describeEvent(current)}: no upcaster`);
      const next = upcaster.up(current);
      const moved =
        next.type === current.type &&
        next.schemaVersion === current.schemaVersion + 1 &&
        next.id === current.id &&
        next.sessionId === current.sessionId &&
        next.seq === current.seq &&
        next.ts === current.ts;
      if (!moved) {
        throw new UpcastError(
          `${describeEvent(current)}: the upcaster must return the same event at v${current.schemaVersion + 1}, changing only schemaVersion and payload`,
        );
      }
      current = next;
    }
    return current;
  }

  return {
    latestVersion: (type) => latest.get(type),
    payloadSchema: (type, schemaVersion) => schemas.get(type)?.get(schemaVersion),
    validate,
    upcast,
    toLatest(event) {
      validate(event);
      const upcasted = upcast(event);
      if (upcasted !== event) {
        const result = schemaFor(upcasted).safeParse(upcasted.payload);
        if (!result.success) {
          throw new EventValidationError(
            `${describeEvent(event)}: upcasted payload is invalid at v${upcasted.schemaVersion}`,
            result.error.issues,
          );
        }
      }
      return upcasted as E;
    },
  };
}

function upcasterKey(type: string, fromVersion: number): string {
  return `${type}@${fromVersion}`;
}

/** Earshot's registry: every payload contract in `@earshot/core`, plus every upcaster. */
export const defaultRegistry: EventRegistry<SessionEvent> = createEventRegistry<SessionEvent>({
  payloads: eventPayloadContracts,
  upcasters,
});
