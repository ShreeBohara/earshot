"use server";

import { importSessionLog } from "@earshot/db";
import { revalidatePath } from "next/cache";
import { log } from "@/lib/auth";
import { MODE } from "@/lib/auth/config";
import { requireViewer, withViewerTenant } from "@/lib/auth/viewer";
import { FINISHING_SAMPLE, SAMPLE_DEBRIEFS } from "@/lib/samples";

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

/**
 * Development only: loads a debrief that's still finishing (ended, not sealed), so the inbox's
 * "Finishing" state can be seen and tested under zero-setup `next dev`, where no flush seals one.
 * Refused anywhere else.
 */
export async function loadFinishingSampleAction(): Promise<SampleDebriefsResult> {
  const viewer = await requireViewer("/settings/data");
  if (MODE !== "development") {
    return { status: "error", message: "That sample is for development only." };
  }
  try {
    const result = await withViewerTenant(
      (tx) => importSessionLog(tx, FINISHING_SAMPLE.jsonl, { mapDemoIds: true, seal: false }),
      viewer,
    );
    revalidatePath("/settings/data");
    return {
      status: "done",
      message: result.created
        ? "Loaded a debrief that's still finishing. The inbox shows it under Finishing."
        : "The finishing debrief is already loaded.",
    };
  } catch (error) {
    log.error("finishing sample load failed", { error });
    return { status: "error", message: "The finishing debrief didn't load. Try again." };
  }
}
