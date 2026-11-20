// Methodology lenses (Phase 5 spec §4.9, WP10 step 3; ADR-0037): configuration, not code. Each
// file in ./lenses names a lens and its fields, with the words the prompt shows the model for
// each. The recap asks for one located quote per field, or "not mentioned"; the device chooses
// the lens in Settings → Capture, and it travels with `end`.
//
// Pure data and types, with no AI SDK: the web app imports this module for the lens's labels
// (`@earshot/agent/recap/lenses`), and `lenses.test.ts` holds the files to their shape.
import type { RecapLensId } from "@earshot/core";
import bant from "./lenses/bant.json" with { type: "json" };
import meddic from "./lenses/meddic.json" with { type: "json" };
import spiced from "./lenses/spiced.json" with { type: "json" };

/** One field of a lens: its id (as `recap.created` stores it), its label, and what it means. */
export interface RecapLensFieldDefinition {
  readonly id: string;
  readonly label: string;
  /** One line for the model: what counts as the rep mentioning this field. */
  readonly describe: string;
}

/** A lens file: `{ id, label, fields: [{ id, label, describe }] }`. */
export interface RecapLensDefinition {
  readonly id: RecapLensId;
  /** As people write it: "MEDDIC". */
  readonly label: string;
  readonly fields: readonly RecapLensFieldDefinition[];
}

/** Every lens, by id, in the order Settings → Capture offers them. */
export const RECAP_LENSES: Readonly<Record<RecapLensId, RecapLensDefinition>> = {
  meddic: meddic as RecapLensDefinition,
  spiced: spiced as RecapLensDefinition,
  bant: bant as RecapLensDefinition,
};

/** The lenses as a list, in the order Settings → Capture offers them. */
export const RECAP_LENS_LIST: readonly RecapLensDefinition[] = Object.values(RECAP_LENSES);

/** A lens by id, or null for none. */
export function recapLens(id: RecapLensId | null | undefined): RecapLensDefinition | null {
  return id ? RECAP_LENSES[id] : null;
}
