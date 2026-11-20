import type { Metadata } from "next";
import { DeviceKeysPanel, DeviceKeysProvider } from "@/components/keys/device-keys";
import { HomeScreenHint } from "@/components/keys/home-screen-hint";
import { VaultKeysPanel } from "@/components/keys/vault-keys";
import { SettingsSection } from "@/components/settings-section";
import { isFreshSession } from "@/lib/auth/fresh";
import { requireViewer } from "@/lib/auth/viewer";
import { keyRouteDeps } from "@/lib/keys/deps";
import { vaultSnapshot } from "@/lib/keys/routes";

export const metadata: Metadata = { title: "Keys · Settings · Earshot" };

/**
 * Where AI provider keys live: on this device by default, or, only if the deployment has a vault
 * and the user stores a key there, on the server (docs/adr/0021).
 */
export default async function KeysSettingsPage() {
  const viewer = await requireViewer("/settings/keys");
  const vault = await vaultSnapshot(viewer, await keyRouteDeps());
  // Keys stored before the vault went off stay listed, so they can be removed.
  const showVault = vault.status === "on" || vault.credentials.length > 0;

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h1 className="font-serif text-4xl tracking-tight">Keys</h1>
        <p className="max-w-prose text-pretty text-muted-foreground">
          Earshot runs on your own speech-to-text and model keys. Each one is checked with its
          provider before it&apos;s saved, and only its last four characters are ever shown.
        </p>
      </header>

      <DeviceKeysProvider>
        <SettingsSection
          id="on-this-device"
          title="On this device"
          description={
            <>
              The default. A key you add here is encrypted in this browser and never stored on
              Earshot&apos;s servers. When a request needs it, this browser sends it along over TLS,
              and the server uses it for that request only. Clearing this site&apos;s data deletes
              these keys, and another device needs its own.
            </>
          }
        >
          <HomeScreenHint />
          <DeviceKeysPanel />
        </SettingsSection>

        {showVault && (
          <SettingsSection
            id="vault"
            title="Stored on the server (vault)"
            description={
              <>
                Optional, one key at a time. A key stored here works on every device you sign in on,
                and for work that runs without you. The trade-off: the server holds it, encrypted
                under a master key that only the server has, so you&apos;re trusting this server
                with it. Keys on this device need no such trust.
              </>
            }
          >
            <VaultKeysPanel
              status={vault.status}
              initialCredentials={vault.credentials}
              fresh={isFreshSession(viewer.session)}
            />
          </SettingsSection>
        )}
      </DeviceKeysProvider>
    </div>
  );
}
