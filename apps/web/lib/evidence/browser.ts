// The browser's evidence clips (Phase 5 spec WP9; ADR-0036): one hub per page, shared by the capture
// controller (which keeps each turn's audio) and the cards (which play it). Safe to import while
// server rendering: nothing touches IndexedDB, Web Audio, or storage until it's used.
import { ClipPlayer, ClipStore } from "@earshot/voice/evidence";
import type { CaptureClips } from "@/lib/capture/controller";
import { EvidenceHub } from "./hub";
import { claimClips, forgetClipsOwner, mayKeepClips, type OwnerStorage } from "./owner";
import { browserStorage, readClipsSetting } from "./setting";

let hub: EvidenceHub | undefined;
/** The signed-in viewer this page keeps clips for, once the evidence provider has claimed them. */
let viewerId: string | null = null;

/** Where the clips' owner is recorded: `localStorage`, guarded (lib/evidence/setting.ts). */
function ownerStorage(): OwnerStorage | undefined {
  return browserStorage();
}

/**
 * Binds this page's clips to the signed-in viewer, as the app opens (the evidence provider calls
 * it). Clips another user left on this browser, or clips with no recorded owner, are cleared first
 * (lib/evidence/owner.ts).
 */
export async function claimBrowserClips(userId: string): Promise<void> {
  viewerId = userId;
  await claimClips(userId, { storage: ownerStorage(), clear: () => clearBrowserClips() });
}

/** Whether this page may keep a clip now: its viewer still owns the device's clip store. */
export function ownsBrowserClips(): boolean {
  return mayKeepClips(viewerId, ownerStorage());
}

/** Forgets whose clips these are, after they're cleared: sign-out and account deletion. */
export function forgetBrowserClipsOwner(): void {
  forgetClipsOwner(ownerStorage());
}

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
  return typeof window !== "undefined" && readClipsSetting(browserStorage()) === "on";
}

/** What the capture controller keeps each turn's audio through. */
export function browserClips(): CaptureClips {
  return {
    enabled: clipsEnabled,
    keep: (clip) => {
      // Only for the viewer who owns the store: a tab still running a debrief after another user
      // signed in, or after a sign-out elsewhere, keeps nothing more.
      if (!ownsBrowserClips()) return;
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
 * and another user's clips found as the app opens. Waits at most a few seconds, so a stuck
 * IndexedDB can't hold a sign-out. Resolves to whether the store was emptied in that time, which
 * claiming the store for a new user needs to know (lib/evidence/owner.ts).
 */
export function clearBrowserClips(waitMs: number = CLEAR_WAIT_MS): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), waitMs);
    void browserEvidence()
      .clear()
      .catch(() => false)
      .then((cleared) => {
        clearTimeout(timer);
        resolve(cleared);
      });
  });
}

/**
 * Leaving this device signed out (spec §4.7: sign-out clears everything), or deleting the account.
 * Capture stops first, so no turn of a debrief still running is kept after the clips are cleared;
 * then the clips go, and the store's owner with them, which other tabs hear as a `storage` event;
 * then the sign-out itself, which runs even if clearing failed.
 */
export async function signOutClearingClips(steps: {
  readonly stopCapture: () => void;
  /** Its result, whether the store was emptied, doesn't stop the sign-out. */
  readonly clearClips: () => Promise<unknown>;
  readonly forgetOwner: () => void;
  readonly signOut: () => Promise<void>;
}): Promise<void> {
  steps.stopCapture();
  try {
    await steps.clearClips();
  } catch {
    // The sign-out still happens. The clips expire within 24 hours, and the next user to open
    // Earshot here clears them anyway, since the store isn't theirs.
  }
  steps.forgetOwner();
  await steps.signOut();
}
