// The rule for key labels, shared by the browser (keys on this device) and the vault routes, and
// matching what packages/db's vault enforces. Labels are shown and audited in plain text, so a
// label can never hold a key.
import { redact } from "@earshot/keys";

/** The label a key gets when none is given; the vault's default too. */
export const DEFAULT_KEY_LABEL = "default";

/** The vault's limit (packages/db/src/vault.ts); a test keeps the two in step. */
export const MAX_KEY_LABEL_LENGTH = 64;

/**
 * The label to store, or null when `raw` isn't acceptable: it must be 1 to 64 printable
 * characters after trimming, and contain neither `secret` nor anything shaped like a provider
 * key. Never echo a rejected label: it may be a key pasted into the wrong field.
 */
export function cleanKeyLabel(raw: string, secret?: string): string | null {
  const label = raw.trim();
  if (!label || label.length > MAX_KEY_LABEL_LENGTH || /\p{Cc}/u.test(label)) return null;
  if (redact(label, secret === undefined ? [] : [secret]) !== label) return null;
  return label;
}
