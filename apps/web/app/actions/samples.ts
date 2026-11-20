"use server";

import { importSessionLog } from "@earshot/db";
import { revalidatePath } from "next/cache";
import { log } from "@/lib/auth";
import { requireViewer, withViewerTenant } from "@/lib/auth/viewer";
import { SAMPLE_DEBRIEFS } from "@/lib/samples";

export type SampleDebriefsResult = { status: "done" | "error"; message: string };

/**
 * Loads the sample debriefs into the viewer's workspace as the viewer's own sealed sessions,
 * pointing their records at the demo CRM's rows when it's loaded (`importSessionLog`). Loading
 * them again adds nothing.
 */
export async function loadSampleDebriefsAction(): Promise<SampleDebriefsResult> {
  // Outside the try: a missing session redirects to sign-in, which must not be caught.
  const viewer = await requireViewer("/settings/data");
  try {
    const results = await withViewerTenant(async (tx) => {
      const imported = [];
      for (const sample of SAMPLE_DEBRIEFS) {
        imported.push(await importSessionLog(tx, sample.jsonl, { mapDemoIds: true }));
      }
      return imported;
    }, viewer);
    revalidatePath("/settings/data");
    const created = results.filter((result) => result.created).length;
    const proposals = results
      .filter((result) => result.created)
      .reduce((sum, result) => sum + result.proposals, 0);
    return {
      status: "done",
      message:
        created === 0
          ? "The sample debriefs are already loaded."
          : `Loaded ${created} sample debrief${created === 1 ? "" : "s"}, with ${proposals} proposals to review.`,
    };
  } catch (error) {
    log.error("sample debriefs load failed", { error });
    return { status: "error", message: "The sample debriefs didn't load. Try again." };
  }
}
