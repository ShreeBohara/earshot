"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  readShortcutsSetting,
  SHORTCUTS_SETTING_EVENT,
  SHORTCUTS_SETTING_KEY,
  writeShortcutsSetting,
} from "@/lib/inbox/keys";

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SHORTCUTS_SETTING_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(SHORTCUTS_SETTING_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(SHORTCUTS_SETTING_EVENT, onChange);
  };
}

const readClient = () => readShortcutsSetting(window.localStorage);
/** Server rendering knows nothing of the device: the default, on. */
const readServer = () => true;

/**
 * This device's inbox shortcuts switch (Settings → Review), kept in step across tabs, and a way to
 * change it.
 */
export function useShortcutsSetting(): readonly [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, readClient, readServer);
  const save = useCallback((next: boolean) => {
    writeShortcutsSetting(next, { storage: window.localStorage, events: window });
  }, []);
  return [on, save] as const;
}
