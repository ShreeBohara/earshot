import { demoCrmStatus } from "@earshot/db";
import type { Metadata } from "next";
import Link from "next/link";
import { DemoCrmSettings } from "@/components/demo-crm-controls";
import { SampleDebriefs } from "@/components/sample-debriefs";
import { SettingsSection } from "@/components/settings-section";
import { requireViewer, withViewerTenant } from "@/lib/auth/viewer";
import { describeDemoCrm } from "@/lib/demo-crm";

export const metadata: Metadata = { title: "Data · Settings · Earshot" };

/** What's in the workspace besides your own captures: the demo CRM, and sample debriefs. */
export default async function DataSettingsPage() {
  const viewer = await requireViewer("/settings/data");
  const { loaded, total, counts } = await withViewerTenant((tx) => demoCrmStatus(tx), viewer);

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h1 className="font-serif text-4xl tracking-tight">Data</h1>
        <p className="max-w-prose text-pretty text-muted-foreground">
          Sample data for your workspace. To download everything Earshot stores about you, go to{" "}
          <Link
            href="/settings/account#data"
            className="rounded-sm underline underline-offset-4 outline-none hover:text-foreground focus-visible:focus-ring"
          >
            Account
          </Link>
          .
        </p>
      </header>

      <SettingsSection
        id="demo-crm"
        title="Demo CRM"
        description={`${describeDemoCrm(counts)}. It gives Earshot a CRM to match names against before you connect a real one. Removing it deletes only the demo records.`}
      >
        <DemoCrmSettings loaded={loaded} total={total} />
      </SettingsSection>

      <SettingsSection
        id="sample-debriefs"
        title="Sample debriefs"
        description="Finished debriefs to review in the inbox before you record your own. They're added as your sessions; loading them again adds nothing."
      >
        <SampleDebriefs />
      </SettingsSection>
    </div>
  );
}
