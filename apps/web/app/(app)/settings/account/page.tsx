import { DownloadIcon } from "lucide-react";
import type { Metadata } from "next";
import { DeleteAccount } from "@/components/account/delete-account";
import { PasskeysPanel } from "@/components/account/passkeys-panel";
import { ProfileForm } from "@/components/account/profile-form";
import { SessionsPanel } from "@/components/account/sessions-panel";
import { linkButton } from "@/components/link-button";
import { SettingsSection } from "@/components/settings-section";
import { listPasskeys, listSignInSessions } from "@/lib/account/queries";
import { describeUserAgent } from "@/lib/account/user-agent";
import { FRESH_SESSION_SECONDS } from "@/lib/auth/server";
import { requireViewer } from "@/lib/auth/viewer";
import { getDb } from "@/lib/db";
import { formatDate, formatRelative } from "@/lib/format";

export const metadata: Metadata = { title: "Account · Settings · Earshot" };

export default async function AccountSettingsPage() {
  const viewer = await requireViewer("/settings/account");
  const db = await getDb();
  // One after the other: on Workers, parallel queries would open more pool connections.
  const sessions = await listSignInSessions(db, viewer.user.id);
  const passkeys = await listPasskeys(db, viewer.user.id);
  const now = new Date();
  const fresh = now.getTime() - viewer.session.createdAt.getTime() < FRESH_SESSION_SECONDS * 1000;

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h1 className="font-serif text-4xl tracking-tight">Account</h1>
        <p className="text-muted-foreground">Your profile, how you sign in, and your data.</p>
      </header>

      <SettingsSection id="profile" title="Profile">
        <ProfileForm
          name={viewer.user.name}
          email={viewer.user.email}
          memberSince={formatDate(viewer.user.createdAt)}
        />
      </SettingsSection>

      <SettingsSection
        id="passkeys"
        title="Passkeys"
        description="Sign in with Face ID, Touch ID, Windows Hello, or a security key instead of waiting for an email."
      >
        <PasskeysPanel
          fresh={fresh}
          passkeys={passkeys.map((passkey) => ({
            id: passkey.id,
            name: passkey.name?.trim() || "Passkey",
            added: formatDate(passkey.createdAt),
            synced: passkey.backedUp,
          }))}
        />
      </SettingsSection>

      <SettingsSection
        id="sessions"
        title="Active sessions"
        description="Everywhere you're signed in. Sign out of any device you don't recognize."
      >
        <SessionsPanel
          sessions={sessions.map((session) => ({
            id: session.id,
            device: describeUserAgent(session.userAgent),
            mobile: /iPhone|iPad|Android|Mobile/.test(session.userAgent ?? ""),
            ipAddress: session.ipAddress,
            lastActive: formatRelative(session.updatedAt, now),
            current: session.id === viewer.session.id,
          }))}
        />
      </SettingsSection>

      <SettingsSection
        id="data"
        title="Your data"
        description="Download everything Earshot stores about you and your workspace as one JSON file. Keys, tokens, and passwords are never included."
      >
        <div>
          {/* A plain link: the browser downloads the file with the session cookie. */}
          <a href="/api/account/export" download className={linkButton({ variant: "outline" })}>
            <DownloadIcon aria-hidden="true" />
            Download your data
          </a>
        </div>
      </SettingsSection>

      <SettingsSection
        id="delete-account"
        title="Delete account"
        tone="danger"
        description="Permanently delete your account and your workspace, with everything in it."
      >
        <DeleteAccount
          email={viewer.user.email}
          workspaceName={viewer.workspaceName}
          fresh={fresh}
        />
      </SettingsSection>
    </div>
  );
}
