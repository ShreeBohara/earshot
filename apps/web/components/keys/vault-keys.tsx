"use client";

import { isProviderId } from "@earshot/keys";
import { Button } from "@earshot/ui/components/button";
import { ServerIcon } from "lucide-react";
import { useId, useState } from "react";
import { ReauthNote } from "@/components/account/reauth-note";
import { formatDate, formatRelative } from "@/lib/format";
import { removeFromVault, storeInVault } from "@/lib/keys/client";
import { describeProblem } from "@/lib/keys/reasons";
import type { KeyProblem, VaultCredential } from "@/lib/keys/types";
import { AddKeyForm, type AddKeyOutcome, type AddKeyValues } from "./add-key-form";
import { PROVIDER_OPTIONS, providerName, useDeviceKeys } from "./device-keys";
import { KeyList, type KeyListItem } from "./key-list";

const KEYS_PAGE = "/settings/keys";
const slotId = (provider: string, label: string) => `${provider}:${label}`;

/**
 * Keys stored in the server vault: metadata from the server, remove, and an explicit, per-key
 * opt-in to store one. Storing needs a recent sign-in. A key stored here goes to this device too
 * only if the user ticks the box.
 */
export function VaultKeysPanel({
  status,
  initialCredentials,
  fresh,
}: {
  status: "on" | "off" | "misconfigured";
  initialCredentials: VaultCredential[];
  fresh: boolean;
}) {
  const device = useDeviceKeys();
  const checkboxId = useId();
  const [credentials, setCredentials] = useState(initialCredentials);
  const [adding, setAdding] = useState(false);
  const [needsReauth, setNeedsReauth] = useState(!fresh);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, KeyProblem>>({});
  const [announcement, setAnnouncement] = useState("");

  const now = new Date();
  const items: KeyListItem[] = credentials.map((credential) => {
    const id = slotId(credential.provider, credential.label);
    const problem = problems[id];
    const meta = `Stored ${formatDate(credential.createdAt)}${
      credential.validatedAt
        ? ` · last passed a check ${formatRelative(credential.validatedAt, now)}`
        : ""
    }`;
    return {
      id,
      providerName: providerName(credential.provider),
      label: credential.label,
      last4: credential.last4,
      meta,
      status: problem
        ? { kind: "problem", problem }
        : credential.validatedAt
          ? { kind: "checked", at: credential.validatedAt }
          : { kind: "unchecked" },
    };
  });

  async function remove(item: KeyListItem) {
    const credential = credentials.find((c) => slotId(c.provider, c.label) === item.id);
    if (!credential) return;
    setBusyId(item.id);
    const result = await removeFromVault(credential.provider, credential.label);
    setBusyId(null);
    if (result.ok) {
      setCredentials((current) => current.filter((c) => c !== credential));
      setAnnouncement(`Removed the ${item.providerName} key “${item.label}” from the server.`);
      return;
    }
    setProblems((current) => ({ ...current, [item.id]: result.problem }));
    setAnnouncement(
      `The ${item.providerName} key “${item.label}” wasn't removed. ${describeProblem(result.problem).message}`,
    );
  }

  async function store(values: AddKeyValues, form: FormData): Promise<AddKeyOutcome> {
    const { provider, label } = values;
    const name = providerName(provider);
    if (!isProviderId(provider)) {
      return { ok: false, message: describeProblem("unknown_provider").message };
    }
    const result = await storeInVault(provider, label, values.key);
    if (!result.ok) {
      if (result.problem === "reauth_required") setNeedsReauth(true);
      const message = describeProblem(result.problem, {
        provider: name,
        ...(result.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: result.retryAfterSeconds }),
      }).message;
      return { ok: false, message };
    }

    const stored = result.credential;
    setCredentials((current) => [
      ...current.filter((c) => slotId(c.provider, c.label) !== slotId(provider, label)),
      stored,
    ]);
    setProblems(({ [slotId(provider, label)]: _cleared, ...rest }) => rest);
    // Only when asked: storing on the server never also stores on this device by default.
    if (form.get("also-on-device") === "on") {
      const saved = await device.saveChecked(provider, label, values.key);
      return saved
        ? {
            ok: true,
            message: `Stored on the server and on this device: your ${name} key ending in ${stored.last4}.`,
          }
        : {
            ok: true,
            message: `Stored on the server, but this browser couldn't keep a copy: your ${name} key ending in ${stored.last4}.`,
          };
    }
    return {
      ok: true,
      message: `Stored on the server: your ${name} key ending in ${stored.last4}.`,
    };
  }

  const notice =
    status === "off"
      ? "The vault is off on this server, so these keys can't be used. You can still remove them."
      : status === "misconfigured"
        ? "The server's vault isn't available right now, so keys can't be stored or used there. You can still remove them."
        : null;

  return (
    <div className="flex flex-col gap-6">
      {notice && (
        <p className="rounded-lg border border-state-conflict-border bg-state-conflict-bg px-3 py-2 text-sm text-state-conflict-text">
          {notice}
        </p>
      )}
      <KeyList
        items={items}
        label="Keys stored on the server"
        empty="No keys stored on the server."
        busyId={busyId}
        onRemove={remove}
      />
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {status === "on" &&
        (needsReauth ? (
          <ReauthNote next={KEYS_PAGE}>
            Storing a key on the server needs a sign-in from the last hour.
          </ReauthNote>
        ) : adding ? (
          <div className="flex flex-col gap-4">
            <h3 className="font-medium text-sm">Store a key on the server</h3>
            <AddKeyForm
              providers={PROVIDER_OPTIONS}
              submitLabel="Check and store on the server"
              replaceLabel="Check and replace on the server"
              workingLabel={(name) => `Checking the key with ${name}, then storing it…`}
              keyHint={(name) =>
                `Earshot checks it with ${name}, then stores it encrypted on the server. It isn't shown again.`
              }
              existing={credentials}
              extraFields={
                <div className="flex items-start gap-2">
                  <input
                    id={checkboxId}
                    name="also-on-device"
                    type="checkbox"
                    disabled={device.state.status !== "ready"}
                    className="mt-0.5 size-4 accent-primary"
                  />
                  <label htmlFor={checkboxId} className="text-sm">
                    Also keep a copy on this device
                  </label>
                </div>
              }
              onSubmit={store}
            />
            <div>
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button variant="outline" onClick={() => setAdding(true)}>
              <ServerIcon aria-hidden="true" />
              Store a key on the server…
            </Button>
          </div>
        ))}
    </div>
  );
}
