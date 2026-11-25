"use client";

import type { RecapLensId } from "@earshot/core";
import { useCallback, useSyncExternalStore } from "react";
import {
  RECAP_LENS_EVENT,
  RECAP_LENS_KEY,
  readRecapLens,
  writeRecapLens,
} from "@/lib/recap/setting";

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === RECAP_LENS_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(RECAP_LENS_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(RECAP_LENS_EVENT, onChange);
  };
}

const readClient = () => readRecapLens(window.localStorage);
/** Server rendering knows nothing of the device: the default, which is none. */
const readServer = (): RecapLensId | null => null;

/** This device's recap lens, kept in step across tabs, and a way to change it. */
export function useRecapLens(): readonly [RecapLensId | null, (lens: RecapLensId | null) => void] {
  const lens = useSyncExternalStore(subscribe, readClient, readServer);
  const save = useCallback((next: RecapLensId | null) => {
    writeRecapLens(next, { storage: window.localStorage, events: window });
  }, []);
  return [lens, save] as const;
}
