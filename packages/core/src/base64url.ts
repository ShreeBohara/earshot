// Base64url without padding (RFC 4648, section 5), in plain JavaScript, so it runs unchanged in
// Workers, Node, and browsers. Session tickets (session-ticket.ts) and policy snapshots
// (policy-snapshot.ts) carry their HMAC signatures in it.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const ALPHABET_INDEX = new Map([...ALPHABET].map((char, index) => [char, index]));

/** Base64url without padding (RFC 4648, section 5). */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const left = bytes.length - i;
    out += ALPHABET.charAt((n >> 18) & 63) + ALPHABET.charAt((n >> 12) & 63);
    if (left > 1) out += ALPHABET.charAt((n >> 6) & 63);
    if (left > 2) out += ALPHABET.charAt(n & 63);
  }
  return out;
}

/**
 * Decodes unpadded base64url, or returns undefined. Only the canonical encoding is accepted (the
 * unused low bits of the last character must be zero), so no two strings decode to the same
 * bytes and a ticket or a signature has exactly one spelling.
 */
export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (text.length % 4 === 1) return undefined;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let length = 0;
  for (const char of text) {
    const value = ALPHABET_INDEX.get(char);
    if (value === undefined) return undefined;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[length++] = buffer >> bits;
      buffer &= (1 << bits) - 1;
    }
  }
  return buffer === 0 ? out : undefined;
}
