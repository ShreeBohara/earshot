// Whether this deployment's vault is on (ADR-0021): it is exactly when EARSHOT_VAULT_MASTER_KEY
// is set. A value that is set but malformed fails closed, as "misconfigured" rather than "off":
// vault requests answer 500, and the log names the variable without quoting it.
import { loadVaultMasterKey } from "@earshot/keys/server";
import type { Logger } from "../log";

export type VaultEnv = { readonly EARSHOT_VAULT_MASTER_KEY?: string | undefined };

export type VaultState =
  | { readonly status: "on"; readonly master: CryptoKey }
  | { readonly status: "off" }
  | { readonly status: "misconfigured" };

export async function readVault(env: VaultEnv, log: Logger): Promise<VaultState> {
  try {
    const master = await loadVaultMasterKey(env);
    return master ? { status: "on", master } : { status: "off" };
  } catch {
    // loadVaultMasterKey's error names the variable and never its value; this line is fixed text.
    log.error("vault unavailable: EARSHOT_VAULT_MASTER_KEY is set but isn't a usable master key");
    return { status: "misconfigured" };
  }
}
