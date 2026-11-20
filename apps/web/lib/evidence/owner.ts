// Whose clips these are (Phase 5 WP9; ADR-0036). The device's clip store belongs to one signed-in
// user, recorded in localStorage (`earshot.evidence.owner`: a user id, never a name or email), so
// the next user to sign in on this browser never inherits the last one's clips, however the last
// session ended: signed out here, expired, or signed out from another device.
//
// - **As the app opens** (`claimClips`), a store recorded for anyone else, or for no one, is
//   cleared before it's claimed.
// - **Before each write** (`mayKeepClips`), a page keeps a clip only while its viewer still owns
//   the store, so a tab left running a debrief after another user signs in keeps nothing more.
// - **Sign-out and account deletion** forget the owner after clearing, and other tabs see that as a
//   `storage` event.

export const CLIPS_OWNER_KEY = "earshot.evidence.owner";

/** The part of `localStorage` the owner lives in. */
export interface OwnerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The user the device's clips belong to; null when none is recorded, or storage is blocked. */
export function clipsOwner(storage: OwnerStorage | undefined): string | null {
  try {
    return storage?.getItem(CLIPS_OWNER_KEY) ?? null;
  } catch {
    return null;
  }
}

function setClipsOwner(storage: OwnerStorage | undefined, userId: string): void {
  try {
    storage?.setItem(CLIPS_OWNER_KEY, userId);
  } catch {
    // Blocked storage records no owner, so `mayKeepClips` keeps nothing: the safe side.
  }
}

/** Forgets the owner, after the clips are cleared: sign-out and account deletion. */
export function forgetClipsOwner(storage: OwnerStorage | undefined): void {
  try {
    storage?.removeItem(CLIPS_OWNER_KEY);
  } catch {
    // Nothing more to do: the clips themselves are already gone.
  }
}

/**
 * Binds the device's clips to `userId` as the app opens. A store recorded for another user, or for
 * no one, is cleared first, since nothing says the clips in it are this user's. Resolves to what
 * happened.
 */
export async function claimClips(
  userId: string,
  deps: { readonly storage: OwnerStorage | undefined; readonly clear: () => Promise<void> },
): Promise<"kept" | "cleared"> {
  if (clipsOwner(deps.storage) === userId) return "kept";
  await deps.clear();
  setClipsOwner(deps.storage, userId);
  return "cleared";
}

/** Whether a page whose viewer is `userId` may keep a clip now: the device's store is theirs. */
export function mayKeepClips(userId: string | null, storage: OwnerStorage | undefined): boolean {
  return userId !== null && clipsOwner(storage) === userId;
}
