import { readApprovalPolicy, schema } from "@earshot/db";
import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { ReviewShortcutsSetting } from "@/components/inbox/review-settings";
import { ApprovalPolicySettings } from "@/components/policies/approval-policy-settings";
import { SettingsSection } from "@/components/settings-section";
import { listPasskeys } from "@/lib/account/queries";
import { isSteppedUp, stepUpEndsAt } from "@/lib/auth/fresh";
import { requireViewer, withViewerTenant } from "@/lib/auth/viewer";
import { getDb } from "@/lib/db";
import { changedBy } from "@/lib/policies/copy";
import { policyView } from "@/lib/policies/routes";
import type { StepUpState } from "@/lib/policies/types";

export const metadata: Metadata = { title: "Review · Settings · Earshot" };

/**
 * How proposals get reviewed: the workspace's approval policy (Phase 5 spec WP11), which approves
 * some proposals as they're created, and this device's single-key shortcuts (WP5). Changing the
 * policy needs a sign-in from the last 5 minutes; the page says how to get one.
 */
export default async function ReviewSettingsPage() {
  const viewer = await requireViewer("/settings/review");
  const now = new Date();
  const stored = await withViewerTenant((tx) => readApprovalPolicy(tx), viewer);
  const policy = stored === null || stored === "invalid" ? null : policyView(stored);
  const db = await getDb();
  // One after the other: on Workers, parallel queries would open more pool connections.
  const passkeys = await listPasskeys(db, viewer.user.id);
  let author: string | null = null;
  if (policy?.createdBy && policy.createdBy !== viewer.user.id) {
    // A member of this workspace, as the version's foreign key requires.
    const { user } = schema;
    const [row] = await db
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, policy.createdBy));
    author = row?.name.trim() || null;
  }
  const stepUp: StepUpState = {
    steppedUp: isSteppedUp(viewer.session, now),
    endsAt: stepUpEndsAt(viewer.session).toISOString(),
    method: viewer.session.signInMethod,
    hasPasskey: passkeys.length > 0,
  };

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h1 className="font-serif text-4xl tracking-tight">Review</h1>
        <p className="max-w-prose text-pretty text-muted-foreground">
          How proposals get reviewed: your workspace’s approval policy, and the keyboard shortcuts
          this browser uses in the inbox.
        </p>
      </header>

      <SettingsSection
        id="approval-policy"
        title="Approval policy"
        description="Let Earshot approve some kinds of proposal as soon as it makes them, while the fields you choose always wait for you. It covers your whole workspace, from the next debrief."
      >
        <ApprovalPolicySettings
          policy={policy}
          changedBy={policy ? changedBy(policy.createdBy, viewer.user.id, author) : null}
          stepUp={stepUp}
          email={viewer.user.email}
          loadedAt={now.toISOString()}
        />
      </SettingsSection>

      <SettingsSection
        id="shortcuts"
        title="Keyboard shortcuts"
        description="Every action in the inbox is a button. These single keys are a faster way to the same buttons. They live in this browser: another device has its own."
      >
        <ReviewShortcutsSetting />
      </SettingsSection>
    </div>
  );
}
