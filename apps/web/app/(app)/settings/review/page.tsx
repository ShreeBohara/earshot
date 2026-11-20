import type { Metadata } from "next";
import { ReviewShortcutsSetting } from "@/components/inbox/review-settings";
import { SettingsSection } from "@/components/settings-section";
import { requireViewer } from "@/lib/auth/viewer";

export const metadata: Metadata = { title: "Review · Settings · Earshot" };

/**
 * How this device reviews proposals in the inbox: for now, its single-key shortcuts (Phase 5 spec
 * WP5). Approval policies join it in WP11.
 */
export default async function ReviewSettingsPage() {
  await requireViewer("/settings/review");
  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h1 className="font-serif text-4xl tracking-tight">Review</h1>
        <p className="max-w-prose text-pretty text-muted-foreground">
          How you review proposals in the inbox on this device. These settings live in this browser:
          another device has its own.
        </p>
      </header>

      <SettingsSection
        id="shortcuts"
        title="Keyboard shortcuts"
        description="Every action in the inbox is a button. These single keys are a faster way to the same buttons."
      >
        <ReviewShortcutsSetting />
      </SettingsSection>
    </div>
  );
}
