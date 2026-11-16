"use client";

import { Button } from "@earshot/ui/components/button";
import { toast } from "@earshot/ui/components/toast";
import { KeyRoundIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { describeUserAgent } from "@/lib/account/user-agent";
import { authClient, describeAuthError } from "@/lib/auth/client";
import { ReauthNote } from "./reauth-note";

export type PasskeyRow = { id: string; name: string; added: string; synced: boolean };

const NOT_FRESH = new Set(["SESSION_NOT_FRESH", "SESSION_EXPIRED"]);

/** List, add, and remove passkeys. Adding one needs a recent sign-in. */
export function PasskeysPanel({ passkeys, fresh }: { passkeys: PasskeyRow[]; fresh: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(!fresh);

  async function add() {
    setError(null);
    setPending("add");
    const result = await authClient.passkey.addPasskey({
      name: describeUserAgent(navigator.userAgent),
    });
    setPending(null);
    if (result?.error) {
      const code = "code" in result.error ? result.error.code : undefined;
      if (NOT_FRESH.has(code ?? "")) setNeedsReauth(true);
      else setError(describeAuthError(result.error, "The passkey wasn't added. Try again."));
      return;
    }
    toast.add({ title: "Passkey added", description: "You can use it the next time you sign in." });
    router.refresh();
  }

  async function remove(id: string) {
    setError(null);
    setPending(id);
    const { error: failure } = await authClient.passkey.deletePasskey({ id });
    setPending(null);
    setConfirming(null);
    if (failure) {
      setError(describeAuthError(failure, "The passkey wasn't removed. Try again."));
      return;
    }
    toast.add({ title: "Passkey removed" });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {passkeys.length === 0 ? (
        <p className="text-muted-foreground text-sm">No passkeys yet.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {passkeys.map((passkey) => (
            <li key={passkey.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <KeyRoundIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-sm">{passkey.name}</p>
                <p className="text-muted-foreground text-xs">
                  Added {passkey.added} ·{" "}
                  {passkey.synced ? "Synced across devices" : "This device only"}
                </p>
              </div>
              {confirming === passkey.id ? (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={pending !== null}
                    onClick={() => remove(passkey.id)}
                    aria-label={`Confirm removing ${passkey.name}`}
                  >
                    {pending === passkey.id ? "Removing…" : "Remove"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending !== null}
                  onClick={() => setConfirming(passkey.id)}
                  aria-label={`Remove ${passkey.name}`}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {needsReauth ? (
        <ReauthNote>Adding a passkey needs a sign-in from the last hour.</ReauthNote>
      ) : (
        <div>
          <Button variant="outline" disabled={pending !== null} onClick={add}>
            <KeyRoundIcon aria-hidden="true" />
            {pending === "add" ? "Waiting for your device…" : "Add a passkey"}
          </Button>
        </div>
      )}
    </div>
  );
}
