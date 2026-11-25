// Keeping credentials out of everything an adapter throws or shows (Phase 6 spec §4.2, decision
// 14; docs/adr/0041). An adapter never holds a token: `CrmContext.fetch` adds it. But a CRM can echo
// a request's credential in an error body, a network error can quote a URL with a key in it, and a
// careless message can copy either. So `CrmError` runs its message and its cause through `redact`,
// the dry run shows the credential as `Bearer •••`, and the conformance suite looks for the
// harness's own credential in every preview and everything thrown. Pure, with no Node APIs.
import { KEY_SHAPES } from "@earshot/core";

/** What a masked credential reads as. */
export const REDACTED = "[REDACTED]";

/** How the dry run shows the credential a request carries (decision 18). */
export const CREDENTIAL_PREVIEW = "Bearer •••";

/** The shortest exact secret worth looking for: shorter ones would mask ordinary words. */
const MIN_SECRET_CHARS = 8;

/**
 * Credential shapes a CRM uses that the provider key shapes (`KEY_SHAPES` in `@earshot/core`)
 * don't cover: HubSpot's private app and service key tokens (`pat-na1-` and a UUID). Twenty's API
 * keys are JWTs, which `KEY_SHAPES` covers. HubSpot's OAuth access tokens and Attio's keys have no
 * fixed shape: only exact-secret redaction, and adapters that never quote a CRM's text, keep those
 * out.
 */
const CRM_TOKEN_SHAPES: readonly RegExp[] = [
  /pat-[a-z]{2,4}\d?-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
];

/** Every shape, global, so `replace` masks each occurrence. */
const SHAPES: readonly RegExp[] = [
  ...KEY_SHAPES.map((shape) => new RegExp(shape.source, "g")),
  ...CRM_TOKEN_SHAPES,
];

/** An `Authorization` header's value, as text or JSON: `Authorization: Bearer x`, `"authorization":"x"`. */
const AUTHORIZATION =
  /((?:["']?)(?:proxy-)?authorization(?:["']?)\s*[:=]\s*)(["']?)([^"'\r\n,}]+)\2/gi;
/** A scheme and its credential: `Bearer x`, `Basic x`, `Token x`. The preview's `•••` isn't one. */
const SCHEME_CREDENTIAL = /\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
/** A credential in a URL's query: `?hapikey=x`, `&access_token=x`. */
const QUERY_CREDENTIAL =
  /([?&](?:access_token|refresh_token|token|api_key|apikey|hapikey|key|client_secret|code)=)[^&\s#"']+/gi;
/** A credential in JSON: `"access_token": "x"`. */
const JSON_CREDENTIAL =
  /("(?:access_token|accessToken|refresh_token|refreshToken|api_key|apiKey|token|client_secret|clientSecret|password|secret)"\s*:\s*")[^"]*(")/g;

/**
 * Masks credentials in text: each of `secrets` (at least 8 characters, raw or JSON-escaped), an
 * `Authorization` header's value, a `Bearer`, `Basic`, or `Token` credential, a credential in a
 * URL's query or in JSON, and anything shaped like a provider key or a CRM token. Ordinary text is
 * left as it is.
 */
export function redact(text: string, secrets: Iterable<string> = []): string {
  let out = text;
  for (const secret of secrets) {
    const value = secret.trim();
    if (value.length < MIN_SECRET_CHARS) continue;
    out = out.split(value).join(REDACTED);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) out = out.split(escaped).join(REDACTED);
  }
  out = out
    .replace(
      AUTHORIZATION,
      (_all, key: string, quote: string) => `${key}${quote}${REDACTED}${quote}`,
    )
    .replace(
      SCHEME_CREDENTIAL,
      (_all, scheme: string, space: string) => `${scheme}${space}${REDACTED}`,
    )
    .replace(QUERY_CREDENTIAL, `$1${REDACTED}`)
    .replace(JSON_CREDENTIAL, `$1${REDACTED}$2`);
  for (const shape of SHAPES) out = out.replace(shape, REDACTED);
  return out;
}

/** How deep `redactCause` follows a chain of causes before it stops. */
const MAX_CAUSE_DEPTH = 4;

/**
 * A cause safe to keep on an error: an `Error` whose name, message, and stack hold no credential
 * and that carries nothing else is kept as it is (with its own cause made safe the same way);
 * any other `Error` becomes a plain copy with its name, its message and stack redacted, and its
 * cause made safe, dropping every other property (a request or a response it carried could hold
 * headers); a string is redacted; anything else becomes a fixed `Error`, since an object can hold a
 * credential anywhere. Undefined stays undefined.
 */
export function redactCause(cause: unknown, depth = 0): unknown {
  if (cause === undefined) return undefined;
  if (typeof cause === "string") return redact(cause);
  if (!(cause instanceof Error)) {
    return new Error(`a ${cause === null ? "null" : typeof cause} value was thrown`);
  }
  const message = redact(cause.message);
  const name = redact(cause.name);
  const stack = cause.stack === undefined ? undefined : redact(cause.stack);
  const inner =
    depth >= MAX_CAUSE_DEPTH || cause.cause === undefined
      ? undefined
      : redactCause(cause.cause, depth + 1);
  const plain =
    Object.keys(cause).length === 0 &&
    message === cause.message &&
    name === cause.name &&
    stack === cause.stack &&
    inner === cause.cause;
  if (plain) return cause;
  const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
  // As an Error's own, not enumerable, so the copy carries nothing it didn't need.
  const own = { enumerable: false, configurable: true, writable: true } as const;
  Object.defineProperty(copy, "name", { ...own, value: name });
  Object.defineProperty(copy, "stack", { ...own, value: stack });
  return copy;
}

/**
 * Whether any string inside `value` holds a run of 8 characters of `secret` (the whole secret if
 * it's shorter): an error's message, name, stack, and own properties, its causes, an object's
 * values, and an array's items, however deep (cycles are followed once). The conformance suite's
 * test of what an adapter throws or previews.
 */
export function holdsSecret(value: unknown, secret: string): boolean {
  const target = secret.trim();
  if (target === "") return false;
  const width = Math.min(MIN_SECRET_CHARS, target.length);
  const fragments = new Set<string>();
  for (let start = 0; start + width <= target.length; start++) {
    fragments.add(target.slice(start, start + width));
  }
  const seen = new Set<unknown>();
  const search = (node: unknown): boolean => {
    if (typeof node === "string") {
      for (const fragment of fragments) if (node.includes(fragment)) return true;
      return false;
    }
    if (typeof node !== "object" || node === null || seen.has(node)) return false;
    seen.add(node);
    if (node instanceof Error) {
      if (search(node.name) || search(node.message) || search(node.stack)) return true;
      if (search(node.cause)) return true;
    }
    if (node instanceof Headers) {
      for (const [key, item] of node) if (search(key) || search(item)) return true;
      return false;
    }
    const entries = Array.isArray(node) ? node : Object.values(node);
    for (const item of entries) if (search(item)) return true;
    return false;
  };
  return search(value);
}
