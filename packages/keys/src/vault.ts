// The optional server vault (ADR-0009), off by default; CRM credentials always use it.
// Envelope encryption: each secret gets its own AES-256-GCM data key, and the data key is
// wrapped by the master key (a Worker secret, VAULT_MASTER_KEY). Rotating the master key
// re-wraps the data keys and leaves every ciphertext untouched. The context string is
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
const GCM = "AES-GCM";

function fromBase64(value: string): Bytes {
  const binary = atob(value.trim());
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** A new master key, base64-encoded, for `wrangler secret put VAULT_MASTER_KEY`. */
export function generateMasterKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

/** Imports the master key. It can only wrap and unwrap data keys, never encrypt data. */
export async function importMasterKey(base64: string): Promise<CryptoKey> {
  let raw: Bytes;
  try {
    raw = fromBase64(base64);
  } catch {
    throw new Error("VAULT_MASTER_KEY isn't valid base64.");
  }
  if (raw.byteLength !== 32) throw new Error("VAULT_MASTER_KEY must be 32 bytes, base64-encoded.");
  return crypto.subtle.importKey("raw", raw, { name: GCM }, false, ["wrapKey", "unwrapKey"]);
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
  const additionalData = encoder.encode(context);
  const dek = await crypto.subtle.generateKey({ name: GCM, length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: GCM, iv, additionalData }, dek, encoder.encode(secret)),
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
  const additionalData = encoder.encode(context);
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
  const additionalData = encoder.encode(context);
  const dek = await unwrapDek(oldMaster, sealed, additionalData, true);
  const dekIv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedDek = new Uint8Array(
    await crypto.subtle.wrapKey("raw", dek, newMaster, { name: GCM, iv: dekIv, additionalData }),
  );
  return { ...sealed, wrappedDek, dekIv };
}
