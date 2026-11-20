"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  CLIPS_SETTING_EVENT,
  CLIPS_SETTING_KEY,
  type ClipsSetting,
  readClipsSetting,
  writeClipsSetting,
} from "@/lib/evidence/setting";

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === CLIPS_SETTING_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CLIPS_SETTING_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CLIPS_SETTING_EVENT, onChange);
  };
}

const readClient = () => readClipsSetting(window.localStorage);
/** Server rendering knows nothing of the device: the default, which is on. */
const readServer = (): ClipsSetting => "on";

/** This device's evidence clips setting, kept in step across tabs, and a way to change it. */
export function useClipsSetting(): readonly [ClipsSetting, (setting: ClipsSetting) => void] {
  const setting = useSyncExternalStore(subscribe, readClient, readServer);
  const save = useCallback((next: ClipsSetting) => {
    writeClipsSetting(next, { storage: window.localStorage, events: window });
  }, []);
  return [setting, save] as const;
}
