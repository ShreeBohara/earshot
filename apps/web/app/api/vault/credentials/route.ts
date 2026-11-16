import { withViewer } from "@/lib/auth/viewer";
import { keyRouteDeps } from "@/lib/keys/deps";
import { deleteVaultRoute, listVaultRoute, putVaultRoute } from "@/lib/keys/routes";

export const dynamic = "force-dynamic";

// The optional server vault for AI provider keys (docs/adr/0021). Off unless the deployment sets
// EARSHOT_VAULT_MASTER_KEY, and even then a key is stored only when its user stores it here.
// Every answer is metadata: provider, label, last four characters, dates. lib/keys/routes.ts has
// the rules.

/** The workspace's stored keys, and whether the vault is on: `{ vaultAvailable, credentials }`. */
export const GET = withViewer(async (viewer, request) =>
  listVaultRoute(viewer, request, await keyRouteDeps()),
);

/**
 * Stores a key: `{ provider, label? }` in the JSON body, the key in `x-earshot-provider-key`.
 * Needs the vault on (409 otherwise) and a sign-in from the last hour (403), and checks the key
 * with its provider first (422 if it's refused). Rate-limited with key validation.
 */
export const PUT = withViewer(async (viewer, request) =>
  putVaultRoute(viewer, request, await keyRouteDeps()),
);

/** Removes a stored key, named by `{ provider, label? }`. Works while the vault is off. */
export const DELETE = withViewer(async (viewer, request) =>
  deleteVaultRoute(viewer, request, await keyRouteDeps()),
);
