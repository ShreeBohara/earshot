// The optional server vault (ADR-0009), off by default; CRM credentials always use it.
// Envelope encryption: each secret gets its own AES-256-GCM data key, and the data key is
// wrapped by the master key (a Worker secret, EARSHOT_VAULT_MASTER_KEY). Rotating the master
// key re-wraps the data keys and leaves every ciphertext untouched. The context string is
// authenticated with both layers, so a sealed secret can't be moved to another row.

// ArrayBuffer-backed bytes: WebCrypto rejects views over a SharedArrayBuffer.
type Bytes = Uint8Array<ArrayBuffer>;

export interface SealedSecret {
  readonly ciphertext: Bytes;
  readonly iv: Bytes;
  readonly wrappedDek: Bytes;
  readonly dekIv: Bytes;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 bytes on a plain ArrayBuffer. Workers' types widen `encode()` to ArrayBufferLike. */
function utf8(text: string): Bytes {
  return encoder.encode(text) as Bytes;
}
const GCM = "AES-GCM";

function fromBase64(value: string): Bytes {
  const binary = atob(value.trim());
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** The Worker secret that holds the master key. While it's unset, the vault is off. */
export const VAULT_MASTER_KEY_ENV = "EARSHOT_VAULT_MASTER_KEY";

/** A new master key, base64-encoded, for `wrangler secret put EARSHOT_VAULT_MASTER_KEY`. */
export function generateMasterKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Imports a master key. It can only wrap and unwrap data keys, never encrypt data. Errors never
 * include the value.
 */
export async function importMasterKey(base64: string): Promise<CryptoKey> {
  let raw: Bytes;
  try {
    raw = fromBase64(base64);
  } catch {
    throw new Error("The vault master key isn't valid base64.");
  }
  if (raw.byteLength !== 32) {
    throw new Error("The vault master key must be 32 bytes, base64-encoded.");
  }
  return crypto.subtle.importKey("raw", raw, { name: GCM }, false, ["wrapKey", "unwrapKey"]);
}

/**
 * The deployment's master key, or null when the vault is off because `EARSHOT_VAULT_MASTER_KEY`
 * is unset or empty. When this returns null, callers must refuse to store or reveal vault
 * secrets: that is how the server never stores an AI key unless the vault is on (ADR-0009).
 * `@earshot/db`'s `putCredential` and `revealCredential` throw `VaultOffError` when given null.
 *
 * A value that is set but malformed throws rather than turning the vault off, because rows
 * sealed with the intended key would otherwise look lost. The error names the variable, never
 * its value.
 */
export async function loadVaultMasterKey(env: {
  readonly EARSHOT_VAULT_MASTER_KEY?: string | undefined;
}): Promise<CryptoKey | null> {
  const value = env.EARSHOT_VAULT_MASTER_KEY?.trim();
  if (!value) return null;
  try {
    return await importMasterKey(value);
  } catch (error) {
    throw new Error(`${VAULT_MASTER_KEY_ENV} is set, but it isn't a usable master key.`, {
      cause: error,
    });
  }
}

/** The context a vault row is bound to. */
export function vaultContext(workspaceId: string, kind: string, name: string): string {
  return `earshot:vault:v1:${workspaceId}:${kind}:${name}`;
}

export async function sealSecret(
  master: CryptoKey,
  secret: string,
  context: string,
): Promise<SealedSecret> {
  const additionalData = utf8(context);
  // An AES key, never a key pair: Workers' types return the union for every algorithm.
  const dek = (await crypto.subtle.generateKey({ name: GCM, length: 256 }, true, [
    "encrypt",
    "decrypt",
  ])) as CryptoKey;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: GCM, iv, additionalData }, dek, utf8(secret)),
  );
  const dekIv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedDek = new Uint8Array(
    await crypto.subtle.wrapKey("raw", dek, master, { name: GCM, iv: dekIv, additionalData }),
  );
  return { ciphertext, iv, wrappedDek, dekIv };
}

async function unwrapDek(
  master: CryptoKey,
  sealed: SealedSecret,
  additionalData: Bytes,
  extractable: boolean,
): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    "raw",
    sealed.wrappedDek,
    master,
    { name: GCM, iv: sealed.dekIv, additionalData },
    { name: GCM },
    extractable,
    ["encrypt", "decrypt"],
  );
}

export async function openSecret(
  master: CryptoKey,
  sealed: SealedSecret,
  context: string,
): Promise<string> {
  const additionalData = utf8(context);
  const dek = await unwrapDek(master, sealed, additionalData, false);
  const plain = await crypto.subtle.decrypt(
    { name: GCM, iv: sealed.iv, additionalData },
    dek,
    sealed.ciphertext,
  );
  return decoder.decode(plain);
}

/** Master-key rotation: unwrap the data key with the old master, wrap it with the new one. */
export async function rewrapSecret(
  oldMaster: CryptoKey,
  newMaster: CryptoKey,
  sealed: SealedSecret,
  context: string,
): Promise<SealedSecret> {
  const additionalData = utf8(context);
  const dek = await unwrapDek(oldMaster, sealed, additionalData, true);
  const dekIv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedDek = new Uint8Array(
    await crypto.subtle.wrapKey("raw", dek, newMaster, { name: GCM, iv: dekIv, additionalData }),
  );
  return { ...sealed, wrappedDek, dekIv };
}

const PROBE_CONTEXT = "earshot:vault:v1:same-key-probe";

/**
 * True if two master keys are the same key. Their bytes can't be read, so this seals a
 * throwaway secret with one and tries to open it with the other.
 */
export async function sameMasterKey(a: CryptoKey, b: CryptoKey): Promise<boolean> {
  const probe = await sealSecret(a, "probe", PROBE_CONTEXT);
  try {
    await openSecret(b, probe, PROBE_CONTEXT);
    return true;
  } catch {
    return false;
  }
}
