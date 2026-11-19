// The 30 eval debriefs, parsed when the module loads, as @earshot/demo-crm parses its data, so a
// malformed script fails at import with its id in the message. Static imports, not a directory
// read, so the scripts bundle into workerd and the browser as well as Node. A test checks this
// list against debriefs/*.json, so a new file can't be left out.

import d001 from "../debriefs/d001.json" with { type: "json" };
import d002 from "../debriefs/d002.json" with { type: "json" };
import d003 from "../debriefs/d003.json" with { type: "json" };
import d004 from "../debriefs/d004.json" with { type: "json" };
import d005 from "../debriefs/d005.json" with { type: "json" };
import d006 from "../debriefs/d006.json" with { type: "json" };
import d007 from "../debriefs/d007.json" with { type: "json" };
import d008 from "../debriefs/d008.json" with { type: "json" };
import d009 from "../debriefs/d009.json" with { type: "json" };
import d010 from "../debriefs/d010.json" with { type: "json" };
import d011 from "../debriefs/d011.json" with { type: "json" };
import d012 from "../debriefs/d012.json" with { type: "json" };
import d013 from "../debriefs/d013.json" with { type: "json" };
import d014 from "../debriefs/d014.json" with { type: "json" };
import d015 from "../debriefs/d015.json" with { type: "json" };
import d016 from "../debriefs/d016.json" with { type: "json" };
import d017 from "../debriefs/d017.json" with { type: "json" };
import d018 from "../debriefs/d018.json" with { type: "json" };
import d019 from "../debriefs/d019.json" with { type: "json" };
import d020 from "../debriefs/d020.json" with { type: "json" };
import d021 from "../debriefs/d021.json" with { type: "json" };
import d022 from "../debriefs/d022.json" with { type: "json" };
import d023 from "../debriefs/d023.json" with { type: "json" };
import d024 from "../debriefs/d024.json" with { type: "json" };
import d025 from "../debriefs/d025.json" with { type: "json" };
import d026 from "../debriefs/d026.json" with { type: "json" };
import d027 from "../debriefs/d027.json" with { type: "json" };
import d028 from "../debriefs/d028.json" with { type: "json" };
import d029 from "../debriefs/d029.json" with { type: "json" };
import d030 from "../debriefs/d030.json" with { type: "json" };
import { DebriefScript } from "./schema";

function parse(raw: unknown, file: string): DebriefScript {
  const result = DebriefScript.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`debriefs/${file}.json is not a valid debrief script: ${problems}`);
  }
  if (result.data.id !== file) {
    throw new Error(
      `debriefs/${file}.json has id ${result.data.id}; the id must match the file name`,
    );
  }
  return result.data;
}

const RAW: Readonly<Record<string, unknown>> = {
  d001,
  d002,
  d003,
  d004,
  d005,
  d006,
  d007,
  d008,
  d009,
  d010,
  d011,
  d012,
  d013,
  d014,
  d015,
  d016,
  d017,
  d018,
  d019,
  d020,
  d021,
  d022,
  d023,
  d024,
  d025,
  d026,
  d027,
  d028,
  d029,
  d030,
};

/** Every script, in id order. */
export const DEBRIEFS: readonly DebriefScript[] = Object.entries(RAW).map(([file, raw]) =>
  parse(raw, file),
);

/** The ids of the files `DEBRIEFS` holds, for the test that compares them with the directory. */
export const DEBRIEF_FILES: readonly string[] = Object.keys(RAW);

/** One script by id; throws for an unknown id. */
export function debrief(id: string): DebriefScript {
  const found = DEBRIEFS.find((script) => script.id === id);
  if (!found) throw new RangeError(`no debrief script ${id}`);
  return found;
}
