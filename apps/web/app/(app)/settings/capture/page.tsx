import type { Metadata } from "next";
import { WitnessSettings } from "@/components/capture/witness-settings";
import { ClipsSettings } from "@/components/evidence/clips-settings";
import { SettingsSection } from "@/components/settings-section";
import { requireViewer } from "@/lib/auth/viewer";
import { WITNESS_COPY } from "@/lib/capture/witness";
import { CLIPS_COPY } from "@/lib/evidence/copy";

export const metadata: Metadata = { title: "Capture · Settings · Earshot" };

/**
 * How this device captures debriefs: the second witness (Phase 4 WP9), and evidence clips (Phase 5
 * WP9), each turn's audio kept here for 24 hours to replay while reviewing.
 */
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

      <SettingsSection id="evidence-clips" title={CLIPS_COPY.name}>
        <ClipsSettings labelledBy="evidence-clips" />
      </SettingsSection>
    </div>
  );
}
