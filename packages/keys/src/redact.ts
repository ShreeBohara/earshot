// Keeps keys out of logs, errors, and responses (plan §4, "Security and privacy").

/** The header a client uses to send a provider key for a single request. */
export const PROVIDER_KEY_HEADER = "x-earshot-provider-key";
/** The header naming which provider that key is for. */
export const PROVIDER_ID_HEADER = "x-earshot-provider";

/**
 * Shapes of well-known provider keys and short-lived credentials, caught even when the exact
 * secret isn't known. Deepgram and AssemblyAI keys have no fixed prefix, so they rely on
 * exact-secret redaction instead: each request hands its logger the key it carries.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, // OpenAI
  /gsk_[A-Za-z0-9]{20,}/g, // Groq
  /AIza[0-9A-Za-z_-]{35}/g, // Google
  /ek_[A-Za-z0-9]{20,}/g, // OpenAI ephemeral keys (Realtime client secrets)
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT-shaped, such as a Deepgram grant
];

const MASK = "[REDACTED]";

/** Replaces every occurrence of the given secrets, and anything shaped like a known key. */
export function redact(text: string, secrets: Iterable<string> = []): string {
  let out = text;
  for (const secret of secrets) {
    const value = secret.trim();
    if (value.length >= 8) out = out.split(value).join(MASK);
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, MASK);
  return out;
}

/** Deeply redacts strings inside a JSON-serializable value. */
export function redactValue<T>(value: T, secrets: Iterable<string> = []): T {
  const list = [...secrets];
  return JSON.parse(JSON.stringify(value), (_key, v: unknown) =>
    typeof v === "string" ? redact(v, list) : v,
  ) as T;
}

/** True if any form of the secret (raw or JSON-escaped) appears in the haystack. */
export function containsSecret(haystack: string, secret: string): boolean {
  const value = secret.trim();
  return haystack.includes(value) || haystack.includes(JSON.stringify(value).slice(1, -1));
}

/**
 * The first run of `minLength` consecutive characters of `secret` that appears in `haystack`, or
 * undefined. Stricter than `containsSecret`: tests use it to show that not even part of a key
 * leaked. A secret shorter than `minLength` is looked for whole.
 */
export function findSecretFragment(
  haystack: string,
  secret: string,
  minLength = 8,
): string | undefined {
  const value = secret.trim();
  const width = Math.min(minLength, value.length);
  if (width === 0) return undefined;
  for (let start = 0; start + width <= value.length; start++) {
    const fragment = value.slice(start, start + width);
    if (haystack.includes(fragment)) return fragment;
  }
  return undefined;
}

export type LogSink = (line: string) => void;

/** Where server code logs. `createRedactingLogger` makes one that scrubs secrets first. */
export interface Logger {
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

/** A logger that redacts before writing. Every server log line goes through one of these. */
export function createRedactingLogger(
  sink: LogSink,
  secrets: () => Iterable<string> = () => [],
): Logger {
  const write = (level: string, message: string, detail?: unknown) => {
    const body = detail === undefined ? message : `${message} ${JSON.stringify(detail)}`;
    sink(`${level} ${redact(body, secrets())}`);
  };
  return {
    info: (message: string, detail?: unknown) => write("info", message, detail),
    warn: (message: string, detail?: unknown) => write("warn", message, detail),
    error: (message: string, detail?: unknown) => write("error", message, detail),
  };
}
