import { companies, contacts, deals } from "@earshot/demo-crm";
import manifest from "@earshot/evals/pilot/pilot.v1/manifest.json";
import practice from "@earshot/evals/pilot/pilot.v1/practice.jsonl";
import s01 from "@earshot/evals/pilot/pilot.v1/s01.jsonl";
import s02 from "@earshot/evals/pilot/pilot.v1/s02.jsonl";
import s03 from "@earshot/evals/pilot/pilot.v1/s03.jsonl";
import s04 from "@earshot/evals/pilot/pilot.v1/s04.jsonl";
import s05 from "@earshot/evals/pilot/pilot.v1/s05.jsonl";
import s06 from "@earshot/evals/pilot/pilot.v1/s06.jsonl";
import s07 from "@earshot/evals/pilot/pilot.v1/s07.jsonl";
import s08 from "@earshot/evals/pilot/pilot.v1/s08.jsonl";
import s09 from "@earshot/evals/pilot/pilot.v1/s09.jsonl";
import s10 from "@earshot/evals/pilot/pilot.v1/s10.jsonl";
import type { Metadata } from "next";
import { PilotApp } from "@/components/pilot/pilot-app";
import { consentBlocks } from "@/lib/pilot/consent";
import { buildPilotData } from "@/lib/pilot/data";
import consentMarkdown from "../../../../docs/pilot/consent.md";

export const metadata: Metadata = {
  title: "Review pilot · Earshot",
  description: "Earshot's five-person review pilot: synthetic debriefs, reviewed by keyboard.",
  // A study page, not a product page.
  robots: { index: false, follow: false },
};

// Built once and served as static HTML, like /demo: no database, account, edge Worker, or
// provider. pilot.v1's logs and manifest are bundled as text (the *.jsonl rule in next.config.ts)
// and docs/pilot/consent.md as text (the *.md rule), and both are read here at build time. The
// participant's number comes from ?p= in the browser, and their progress stays in the tab.
export const dynamic = "force-static";

const LOGS: Readonly<Record<string, string>> = {
  "s01.jsonl": s01,
  "s02.jsonl": s02,
  "s03.jsonl": s03,
  "s04.jsonl": s04,
  "s05.jsonl": s05,
  "s06.jsonl": s06,
  "s07.jsonl": s07,
  "s08.jsonl": s08,
  "s09.jsonl": s09,
  "s10.jsonl": s10,
  "practice.jsonl": practice,
};

export default function PilotPage() {
  const data = buildPilotData({ manifest, logs: LOGS, crm: { companies, contacts, deals } });
  return <PilotApp data={data} consent={consentBlocks(consentMarkdown)} />;
}
