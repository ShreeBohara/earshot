"use server";

import { loadDemoCrm, removeDemoCrm } from "@earshot/db";
import { revalidatePath } from "next/cache";
import { log } from "@/lib/auth";
import { requireViewer, withViewerTenant } from "@/lib/auth/viewer";

export type DemoCrmResult = { status: "done" | "error"; message: string };

/** Pages that show whether the demo CRM is loaded. */
function refreshPages() {
  revalidatePath("/settings/data");
  revalidatePath("/onboarding");
}

/**
 * Loads the demo CRM (@earshot/demo-crm) into the viewer's workspace. Loading it again adds only
 * what's missing.
 */
export async function loadDemoCrmAction(): Promise<DemoCrmResult> {
  // Outside the try: a missing session redirects to sign-in, which must not be caught.
  const viewer = await requireViewer("/settings/data");
  try {
    const { inserted, total } = await withViewerTenant((tx) => loadDemoCrm(tx), viewer);
    refreshPages();
    return {
      status: "done",
      message:
        inserted === 0
          ? "The demo CRM is already loaded."
          : `Loaded the demo CRM: ${inserted} of ${total} records added.`,
    };
  } catch (error) {
    log.error("demo CRM load failed", { error });
    return { status: "error", message: "The demo CRM didn't load. Try again." };
  }
}

/** Removes the demo CRM's records from the viewer's workspace, and nothing else. */
export async function removeDemoCrmAction(): Promise<DemoCrmResult> {
  const viewer = await requireViewer("/settings/data");
  try {
    const { deleted } = await withViewerTenant((tx) => removeDemoCrm(tx), viewer);
    refreshPages();
    return {
      status: "done",
      message:
        deleted === 0
          ? "The demo CRM wasn't loaded."
          : `Removed the demo CRM's ${deleted} records.`,
    };
  } catch (error) {
    log.error("demo CRM removal failed", { error });
    return { status: "error", message: "The demo CRM wasn't removed. Try again." };
  }
}
