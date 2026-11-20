import type { Metadata } from "next";
import { WitnessSettings } from "@/components/capture/witness-settings";
import { SettingsSection } from "@/components/settings-section";
import { requireViewer } from "@/lib/auth/viewer";
import { WITNESS_COPY } from "@/lib/capture/witness";

export const metadata: Metadata = { title: "Capture · Settings · Earshot" };

/** How this device captures debriefs: for now, the second witness (Phase 4 WP9). */
export default async function CaptureSettingsPage() {
  await requireViewer("/settings/capture");
  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h1 className="font-serif text-4xl tracking-tight">Capture</h1>
        <p className="max-w-prose text-pretty text-muted-foreground">
          How debriefs on this device are captured. These settings live in this browser, like the
          keys on this device: another device has its own.
        </p>
      </header>

      <SettingsSection
        id="second-witness"
        title={WITNESS_COPY.name}
        description="A second, independent transcript of each turn, without the CRM's names to bias it, so a name the live transcript snapped to a CRM spelling gets caught."
      >
        <WitnessSettings />
      </SettingsSection>
    </div>
  );
}
