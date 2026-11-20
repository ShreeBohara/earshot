// All 200 eval debriefs (Phase 4 WP10, ADR-0031): the 30 hand-written scripts (`DEBRIEFS`, format
// v1, upgraded when they load) and the 170 the seeded grammar generated (debriefs/generated/,
// format v2). Parsed when the module loads, so a malformed file fails at import with its id.
//
// A separate entry point from `@earshot/evals`, so the e2e edge Worker, which reads the 30 the
// fake-microphone eval renders, never bundles the other 170.
import { DEBRIEFS } from "../debriefs";
import { DebriefScript } from "../schema";
import { GENERATED_RAW } from "./generated";

function parse(raw: unknown, id: string): DebriefScript {
  const result = DebriefScript.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`debriefs/generated/${id}.json is not a valid debrief script: ${problems}`);
  }
  if (result.data.id !== id) {
    throw new Error(
      `debriefs/generated/${id}.json has id ${result.data.id}; it must match the file`,
    );
  }
  return result.data;
}

/** d031–d200, in id order. */
export const GENERATED_DEBRIEFS: readonly DebriefScript[] = Object.entries(GENERATED_RAW).map(
  ([id, raw]) => parse(raw, id),
);

/** The ids of the files `GENERATED_DEBRIEFS` holds, for the test that compares them with the directory. */
export const GENERATED_FILES: readonly string[] = Object.keys(GENERATED_RAW);

/** Every script, d001–d200, in id order. */
export const ALL_DEBRIEFS: readonly DebriefScript[] = [...DEBRIEFS, ...GENERATED_DEBRIEFS];

/** One script of the 200 by id; throws for an unknown id. */
export function anyDebrief(id: string): DebriefScript {
  const found = ALL_DEBRIEFS.find((script) => script.id === id);
  if (!found) throw new RangeError(`no debrief script ${id}`);
  return found;
}
