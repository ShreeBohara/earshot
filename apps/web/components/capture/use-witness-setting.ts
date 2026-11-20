"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  readWitnessSetting,
  WITNESS_SETTING_EVENT,
  WITNESS_SETTING_KEY,
  type WitnessSetting,
  writeWitnessSetting,
} from "@/lib/capture/witness";

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === WITNESS_SETTING_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(WITNESS_SETTING_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(WITNESS_SETTING_EVENT, onChange);
  };
}

const readClient = () => readWitnessSetting(window.localStorage);
/** Server rendering knows nothing of the device: as if not asked, which the keys then gate. */
const readServer = () => null;

/** This device's second-witness answer, kept in step across tabs, and a way to change it. */
export function useWitnessSetting(): readonly [
  WitnessSetting | null,
  (setting: WitnessSetting) => void,
] {
  const setting = useSyncExternalStore(subscribe, readClient, readServer);
  const save = useCallback((next: WitnessSetting) => {
    writeWitnessSetting(next, { storage: window.localStorage, events: window });
  }, []);
  return [setting, save] as const;
}
