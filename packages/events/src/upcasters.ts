import type { Upcaster } from "./types";

/**
 * `utterance.final` v1 → v2. Version 1 predates the second witness: every v1 utterance came from
 * the keyterm-biased speech-to-text stream, so it upcasts with `witness: "biased"`.
 */
export const utteranceFinalV1ToV2: Upcaster = {
  type: "utterance.final",
  fromVersion: 1,
  up: (event) => ({
    ...event,
    schemaVersion: 2,
    payload: { ...event.payload, witness: "biased" },
  }),
};

/** Every upcaster Earshot ships, in no particular order: the registry chains them by version. */
export const upcasters: readonly Upcaster[] = [utteranceFinalV1ToV2];
