// The browser's evidence clips (Phase 5 spec WP9; ADR-0036): one hub per page, shared by the capture
// controller (which keeps each turn's audio) and the cards (which play it). Safe to import while
// server rendering: nothing touches IndexedDB, Web Audio, or storage until it's used.
import { ClipPlayer, ClipStore } from "@earshot/voice/evidence";
import type { CaptureClips } from "@/lib/capture/controller";
import { EvidenceHub } from "./hub";
import { readClipsSetting } from "./setting";

let hub: EvidenceHub | undefined;

/** The page's evidence hub, made on first use. */
export function browserEvidence(): EvidenceHub {
  hub ??= new EvidenceHub({
    openStore: () => ClipStore.open(),
    player: new ClipPlayer(),
    setting: () => (clipsEnabled() ? "on" : "off"),
    now: () => Date.now(),
  });
  return hub;
}

/** Whether this device keeps clips now (Settings → Capture). Off while server rendering. */
export function clipsEnabled(): boolean {
  return typeof window !== "undefined" && readClipsSetting(window.localStorage) === "on";
}

/** What the capture controller keeps each turn's audio through. */
export function browserClips(): CaptureClips {
  return {
    enabled: clipsEnabled,
    keep: (clip) => {
      void browserEvidence()
        .store()
        .then((store) => store.put(clip))
        // A turn that can't be kept (no IndexedDB, a full disk) is a card with no audio. Nothing is
        // logged: not the error, which could name the session, and never the audio.
        .catch(() => {});
    },
    playing: () => browserEvidence().playing() !== null,
    stop: () => browserEvidence().stop(),
  };
}

/** How long sign-out waits for the clips to go before it signs out anyway. */
const CLEAR_WAIT_MS = 5_000;

/**
 * Deletes every clip on this device and the key they're kept under: sign-out, account deletion,
 * and clips turned off. Waits at most a few seconds, so a stuck IndexedDB can't hold a sign-out.
 */
export function clearBrowserClips(waitMs: number = CLEAR_WAIT_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    void browserEvidence()
      .clear()
      .catch(() => {})
      .then(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

/**
 * Leaving this device signed out (spec §4.7: sign-out clears everything). Capture stops first, so
 * no turn of a debrief still running is kept after the clips are cleared; then the clips go; then
 * the sign-out itself, which runs even if clearing failed.
 */
export async function signOutClearingClips(steps: {
  readonly stopCapture: () => void;
  readonly clearClips: () => Promise<void>;
  readonly signOut: () => Promise<void>;
}): Promise<void> {
  steps.stopCapture();
  try {
    await steps.clearClips();
  } catch {
    // The sign-out still happens; the clips expire within 24 hours and go at the next open.
  }
  await steps.signOut();
}
