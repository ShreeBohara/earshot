"use client";

import {
  DeviceKeyStore,
  isProviderId,
  PROVIDER_IDS,
  PROVIDERS,
  type Provider,
  type ProviderId,
  type StoredKeyMeta,
} from "@earshot/keys";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { formatDate, formatRelative } from "@/lib/format";
import { checkKey } from "@/lib/keys/client";
import { requestPersistenceOnce } from "@/lib/keys/device-storage";
import { describeProblem } from "@/lib/keys/reasons";
import type { KeyProblem } from "@/lib/keys/types";
import {
  AddKeyForm,
  type AddKeyOutcome,
  type AddKeyValues,
  type ProviderOption,
} from "./add-key-form";
import { KeyList, type KeyListItem } from "./key-list";
import type { KeyStatus } from "./key-status";

const USES: Record<Provider["use"], string> = {
  llm: "language models",
  stt: "speech-to-text",
  "llm+speech": "models and speech",
};

/** Every provider Earshot supports, for the add forms. */
export const PROVIDER_OPTIONS: readonly ProviderOption[] = PROVIDER_IDS.map((id) => ({
  id,
  name: PROVIDERS[id].name,
  use: USES[PROVIDERS[id].use],
}));

/** A provider's display name, or its id when Earshot no longer knows it. */
export function providerName(id: string): string {
  return isProviderId(id) ? PROVIDERS[id].name : id;
}

const slotId = (provider: string, label: string) => `${provider}:${label}`;

type DeviceKeys =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; keys: readonly StoredKeyMeta[] };

type DeviceKeysApi = {
  state: DeviceKeys;
  /** Saves a key that just passed a check, replacing any key in the same slot. */
  saveChecked(provider: ProviderId, label: string, key: string): Promise<boolean>;
  remove(provider: ProviderId, label: string): Promise<boolean>;
  /** Decrypts a key in memory for one request. Never keep the result. */
  reveal(provider: ProviderId, label: string): Promise<string | undefined>;
  markChecked(provider: ProviderId, label: string): Promise<void>;
};

const DeviceKeysContext = createContext<DeviceKeysApi | null>(null);

/**
 * This browser's key store (`DeviceKeyStore`: AES-GCM in IndexedDB, under a key JavaScript can't
 * read), shared by the panels on the Keys page. It holds metadata in state, never a key.
 */
export function DeviceKeysProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<DeviceKeyStore | null>(null);
  const [state, setState] = useState<DeviceKeys>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const opened = await DeviceKeyStore.open();
        const keys = await opened.list();
        if (cancelled) return;
        setStore(opened);
        setState({ status: "ready", keys });
      } catch {
        // No IndexedDB (some private windows), or WebCrypto refused.
        if (!cancelled) setState({ status: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async (opened: DeviceKeyStore) => {
    setState({ status: "ready", keys: await opened.list() });
  }, []);

  const api = useMemo<DeviceKeysApi>(
    () => ({
      state,
      async saveChecked(provider, label, key) {
        if (!store) return false;
        try {
          await store.put(provider, label, key);
          // A key is kept on this device now: ask the browser, once, to keep the site's storage.
          void requestPersistenceOnce();
          await store.markValidated(provider, label);
          await refresh(store);
          return true;
        } catch {
          return false;
        }
      },
      async remove(provider, label) {
        if (!store) return false;
        try {
          await store.remove(provider, label);
          await refresh(store);
          return true;
        } catch {
          return false;
        }
      },
      async reveal(provider, label) {
        return store?.get(provider, label);
      },
      async markChecked(provider, label) {
        if (!store) return;
        await store.markValidated(provider, label);
        await refresh(store);
      },
    }),
    [state, store, refresh],
  );

  return <DeviceKeysContext.Provider value={api}>{children}</DeviceKeysContext.Provider>;
}

export function useDeviceKeys(): DeviceKeysApi {
  const api = useContext(DeviceKeysContext);
  if (!api) throw new Error("useDeviceKeys needs a <DeviceKeysProvider> above it");
  return api;
}

/** A sentence for a failed submit or check. */
function problemMessage(problem: KeyProblem, provider: string, retryAfterSeconds?: number) {
  return describeProblem(problem, {
    provider,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  }).message;
}

/** "Added Nov 15, 2026 · last passed a check 3 minutes ago". */
function metaLine(addedAt: string, checkedAt: string | undefined, now: Date): string {
  const added = `Added ${formatDate(addedAt)}`;
  return checkedAt ? `${added} · last passed a check ${formatRelative(checkedAt, now)}` : added;
}

/** The keys in this browser: list, check again, remove, and add (checked first, then saved). */
export function DeviceKeysPanel() {
  const device = useDeviceKeys();
  const [statuses, setStatuses] = useState<Record<string, KeyStatus>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  if (device.state.status === "loading") {
    return <p className="text-muted-foreground text-sm">Loading the keys on this device…</p>;
  }
  if (device.state.status === "unavailable") {
    return (
      <p className="rounded-lg border border-state-conflict-border bg-state-conflict-bg px-3 py-2 text-sm text-state-conflict-text">
        This browser can&apos;t store keys: its storage is turned off, as in some private windows.
        Open Earshot in a regular window to keep keys on this device.
      </p>
    );
  }

  const now = new Date();
  const keys = device.state.keys;
  const items: KeyListItem[] = keys.map((key) => {
    const id = slotId(key.provider, key.label);
    return {
      id,
      providerName: providerName(key.provider),
      label: key.label,
      last4: key.last4,
      meta: metaLine(key.addedAt, key.validatedAt, now),
      status:
        statuses[id] ??
        (key.validatedAt ? { kind: "checked", at: key.validatedAt } : { kind: "unchecked" }),
    };
  });
  const setStatus = (id: string, status: KeyStatus | undefined) =>
    setStatuses(({ [id]: _previous, ...rest }) => (status ? { ...rest, [id]: status } : rest));
  const slotOf = (item: KeyListItem) =>
    keys.find((key) => slotId(key.provider, key.label) === item.id);

  async function checkAgain(item: KeyListItem) {
    const slot = slotOf(item);
    if (!slot) return;
    setStatus(item.id, { kind: "checking" });
    let key: string | undefined;
    try {
      key = await device.reveal(slot.provider, slot.label);
    } catch {
      key = undefined;
    }
    if (!key) {
      setStatus(item.id, { kind: "problem", problem: "storage" });
      setAnnouncement(`${item.providerName} key “${item.label}”: couldn't be read on this device.`);
      return;
    }
    const result = await checkKey(slot.provider, key);
    key = undefined;
    if (result.ok) {
      await device.markChecked(slot.provider, slot.label);
      setStatus(item.id, undefined);
      setAnnouncement(`${item.providerName} key “${item.label}” passed the check.`);
    } else {
      setStatus(item.id, {
        kind: "problem",
        problem: result.problem,
        ...(result.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: result.retryAfterSeconds }),
      });
      setAnnouncement(
        `${item.providerName} key “${item.label}”: ${problemMessage(result.problem, item.providerName, result.retryAfterSeconds)}`,
      );
    }
  }

  async function remove(item: KeyListItem) {
    const slot = slotOf(item);
    if (!slot) return;
    setBusyId(item.id);
    const removed = await device.remove(slot.provider, slot.label);
    setBusyId(null);
    setStatus(item.id, undefined);
    setAnnouncement(
      removed
        ? `Removed the ${item.providerName} key “${item.label}” from this device.`
        : `The ${item.providerName} key “${item.label}” couldn't be removed. Try again.`,
    );
  }

  async function add(values: AddKeyValues): Promise<AddKeyOutcome> {
    const { provider, label } = values;
    const name = providerName(provider);
    if (!isProviderId(provider)) {
      return { ok: false, message: problemMessage("unknown_provider", name) };
    }
    const result = await checkKey(provider, values.key);
    if (!result.ok) {
      return { ok: false, message: problemMessage(result.problem, name, result.retryAfterSeconds) };
    }
    if (!(await device.saveChecked(provider, label, values.key))) {
      return { ok: false, message: problemMessage("storage", name) };
    }
    setStatus(slotId(provider, label), undefined);
    return {
      ok: true,
      message: `Saved on this device: your ${name} key ending in ${result.last4}.`,
    };
  }

  return (
    <div className="flex flex-col gap-6">
      <KeyList
        items={items}
        label="Keys on this device"
        empty="No keys on this device yet. Add one below."
        busyId={busyId}
        onCheck={checkAgain}
        onRemove={remove}
      />
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <div className="flex flex-col gap-4">
        <h3 className="font-medium text-sm">Add a key to this device</h3>
        <AddKeyForm
          providers={PROVIDER_OPTIONS}
          submitLabel="Check and save"
          replaceLabel="Check and replace"
          workingLabel={(name) => `Checking the key with ${name}…`}
          keyHint={(name) =>
            `Earshot checks it with ${name} once, then encrypts it in this browser. It isn't shown again.`
          }
          existing={keys}
          onSubmit={add}
        />
      </div>
    </div>
  );
}
