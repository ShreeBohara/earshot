import { eventPayloadContracts, UtteranceFinalV2 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createEventRegistry,
  defaultRegistry,
  EventValidationError,
  latestVersions,
  UnknownEventError,
  UpcastError,
  type Upcaster,
  utteranceFinalV1ToV2,
} from "../src";
import { deepFreeze, envelope, utterance, utteranceV1 } from "./helpers";

describe("utteranceFinalV1ToV2", () => {
  const v1 = envelope(utteranceV1(1, "Met Dana Lee at Acme."));

  it("sets witness to biased and moves the event to v2, keeping everything else", () => {
    expect(utteranceFinalV1ToV2.up(v1)).toEqual({
      ...v1,
      schemaVersion: 2,
      payload: { ...v1.payload, witness: "biased" },
    });
  });

  it("produces a payload the v2 schema accepts", () => {
    expect(UtteranceFinalV2.safeParse(utteranceFinalV1ToV2.up(v1).payload).success).toBe(true);
  });

  it("doesn't mutate the event it upcasts", () => {
    const frozen = deepFreeze(structuredClone(v1));
    utteranceFinalV1ToV2.up(frozen);
    expect(frozen).toEqual(v1);
  });
});

describe("defaultRegistry", () => {
  it("upcasts a stored v1 utterance to the latest version", () => {
    const v1 = envelope(utteranceV1(1));
    const latest = defaultRegistry.toLatest(v1);
    expect(latest.schemaVersion).toBe(2);
    expect(latest.payload).toEqual({ ...v1.payload, witness: "biased" });
  });

  it("returns an event already at the latest version as is", () => {
    const v2 = envelope(utterance(1));
    expect(defaultRegistry.toLatest(v2)).toBe(v2);
  });

  it("knows the latest version of every event type, matching SessionEvent", () => {
    const types = new Set(eventPayloadContracts.map(({ type }) => type));
    expect([...types].sort()).toEqual(Object.keys(latestVersions).sort());
    for (const [type, version] of Object.entries(latestVersions)) {
      expect(defaultRegistry.latestVersion(type)).toBe(version);
    }
  });

  it("validates a payload against its own version, not the latest", () => {
    const v1WithWitness = envelope({ ...utteranceV1(1), payload: utterance(1).payload });
    expect(() => defaultRegistry.toLatest(v1WithWitness)).toThrow(EventValidationError);
  });

  it("rejects an unknown type and a version newer than it knows", () => {
    const unknown = envelope({ type: "followup.asked", schemaVersion: 1, payload: {} });
    expect(() => defaultRegistry.toLatest(unknown)).toThrow(UnknownEventError);
    const v3 = envelope({ ...utterance(1), schemaVersion: 3 });
    expect(() => defaultRegistry.toLatest(v3)).toThrow(
      /newer than this reader knows \(latest is v2\)/,
    );
  });
});

describe("createEventRegistry", () => {
  // A made-up event type with three versions: one name, then first and last, then a source.
  const heardV1 = {
    type: "contact.heard",
    schemaVersion: 1,
    schema: z.strictObject({ name: z.string() }),
  };
  const payloads = [
    heardV1,
    {
      type: "contact.heard",
      schemaVersion: 2,
      schema: z.strictObject({ firstName: z.string(), lastName: z.string() }),
    },
    {
      type: "contact.heard",
      schemaVersion: 3,
      schema: z.strictObject({
        firstName: z.string(),
        lastName: z.string(),
        source: z.enum(["rep", "crm"]),
      }),
    },
  ];
  const splitName: Upcaster = {
    type: "contact.heard",
    fromVersion: 1,
    up: (event) => {
      const [firstName = "", ...rest] = String(event.payload.name).split(" ");
      return { ...event, schemaVersion: 2, payload: { firstName, lastName: rest.join(" ") } };
    },
  };
  const addSource: Upcaster = {
    type: "contact.heard",
    fromVersion: 2,
    up: (event) => ({ ...event, schemaVersion: 3, payload: { ...event.payload, source: "rep" } }),
  };
  const heard = envelope({
    type: "contact.heard",
    schemaVersion: 1,
    payload: { name: "Dana Lee" },
  });

  it("chains upcasters one version at a time, in any registration order", () => {
    const registry = createEventRegistry({ payloads, upcasters: [addSource, splitName] });
    expect(registry.latestVersion("contact.heard")).toBe(3);
    expect(registry.toLatest(heard)).toEqual({
      ...heard,
      schemaVersion: 3,
      payload: { firstName: "Dana", lastName: "Lee", source: "rep" },
    });
    const v2 = splitName.up(heard);
    expect(registry.toLatest(v2).payload).toEqual({
      firstName: "Dana",
      lastName: "Lee",
      source: "rep",
    });
  });

  it("refuses a chain with a missing link", () => {
    expect(() => createEventRegistry({ payloads, upcasters: [splitName] })).toThrow(
      /contact.heard v2 has no upcaster to v3/,
    );
  });

  it("refuses an upcaster for a version that isn't registered", () => {
    const toV4: Upcaster = { ...addSource, fromVersion: 3 };
    expect(() =>
      createEventRegistry({ payloads, upcasters: [splitName, addSource, toV4] }),
    ).toThrow(UpcastError);
  });

  it("refuses a (type, schemaVersion) registered twice", () => {
    expect(() => createEventRegistry({ payloads: [...payloads, heardV1] })).toThrow(
      /registered twice/,
    );
  });

  it("rejects an upcaster that skips a version", () => {
    const skips: Upcaster = {
      ...splitName,
      up: (event) => ({ ...addSource.up(splitName.up(event)), schemaVersion: 3 }),
    };
    const registry = createEventRegistry({ payloads, upcasters: [skips, addSource] });
    expect(() => registry.toLatest(heard)).toThrow(UpcastError);
  });

  it("rejects an upcaster that changes the envelope", () => {
    const moves: Upcaster = { ...splitName, up: (event) => ({ ...splitName.up(event), seq: 7 }) };
    const registry = createEventRegistry({ payloads, upcasters: [moves, addSource] });
    expect(() => registry.toLatest(heard)).toThrow(/changing only schemaVersion and payload/);
  });

  it("rejects an upcaster whose output the newer schema refuses", () => {
    const loses: Upcaster = { ...addSource, up: (event) => ({ ...event, schemaVersion: 3 }) };
    const registry = createEventRegistry({ payloads, upcasters: [splitName, loses] });
    expect(() => registry.toLatest(heard)).toThrow(/upcasted payload is invalid at v3/);
  });
});
