// The keys on this device, as the capture screen needs them: metadata for the pickers, and a key
// decrypted in memory for one request. The store opens on first use (it needs IndexedDB).
import { DeviceKeyStore, type ProviderId, type StoredKeyMeta } from "@earshot/keys";

export interface DeviceKeySource {
  list(): Promise<StoredKeyMeta[]>;
  /** Decrypts one key. Never keep the result past the request that needs it. */
  reveal(provider: ProviderId, label: string): Promise<string | undefined>;
}

export function browserDeviceKeys(): DeviceKeySource {
  let opened: Promise<DeviceKeyStore> | undefined;
  const store = () => {
    opened ??= DeviceKeyStore.open();
    opened.catch(() => {
      opened = undefined;
    });
    return opened;
  };
  return {
    list: async () => (await store()).list(),
    reveal: async (provider, label) => (await store()).get(provider, label),
  };
}
