import {
  createRedactingLogger,
  type Logger,
  type LogSink,
  redact,
  redactValue,
} from "@earshot/keys/server";

/**
 * The server's logger. Every line goes through @earshot/keys' redaction: the secrets passed in
 * (the auth secret, provider client secrets, the email API key, the database URL, the vault and
 * ticket secrets) and anything shaped like a provider key or a JWT come out as [REDACTED]. Never
 * pass magic links, session tokens, or email addresses: redaction can't recognize those, so
 * callers keep them out (docs/adr/0006). Errors are logged as their name and code only
 * (`errorSummary`).
 */
export type { Logger };

const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const ERROR_CODE = /^[A-Za-z0-9_]{1,64}$/;

/**
 * What an error may contribute to a log line: its class name and its code (an SQLSTATE, a Node
 * error code, or Better Auth's `body.code`), each only if it's a plain identifier. Never the
 * message, the stack, or the cause: a database error's message can quote the query and its
 * parameters, and other libraries' messages can quote requests, emails, or tokens.
 */
export function errorSummary(error: unknown): { name?: string; code?: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  const summary: { name?: string; code?: string } = {};
  if (ERROR_NAME.test(error.name)) summary.name = error.name;
  const code =
    (error as { code?: unknown }).code ?? (error as { body?: { code?: unknown } }).body?.code;
  if (typeof code === "string" && ERROR_CODE.test(code)) summary.code = code;
  return summary;
}

const EMAIL = /[^\s@<>()[\]"'`,;:]+@[^\s@<>()[\]"'`,;:]+\.[^\s@<>()[\]"'`,;:]+/g;
// Session tokens, magic-link tokens, and other opaque credentials are long runs of URL-safe
// characters that mix cases or mix letters and digits. Shorter runs, and long lowercase words such
// as a route's path segments, are left alone.
const LONG_RUN = /[A-Za-z0-9_-]{24,}/g;

function looksRandom(run: string): boolean {
  const lower = /[a-z]/.test(run);
  const upper = /[A-Z]/.test(run);
  return (lower && upper) || (/[0-9]/.test(run) && (lower || upper));
}

/**
 * A message from code we don't control, made safe to log: known secret shapes redacted, and email
 * addresses and long opaque tokens masked.
 */
export function scrubMessage(message: unknown): string {
  const text =
    message instanceof Error ? (errorSummary(message)?.name ?? "Error") : String(message);
  return redact(text)
    .replace(EMAIL, "[EMAIL]")
    .replace(LONG_RUN, (run) => (looksRandom(run) ? "[TOKEN]" : run));
}

/** Errors serialize to `{}`; log their summary instead. */
function plain(detail: unknown): unknown {
  if (detail instanceof Error) return errorSummary(detail);
  if (Array.isArray(detail)) return detail.map(plain);
  if (detail !== null && typeof detail === "object") {
    return Object.fromEntries(Object.entries(detail).map(([key, value]) => [key, plain(value)]));
  }
  return detail;
}

const consoleSink: LogSink = (line) => {
  if (line.startsWith("error ")) console.error(`[earshot] ${line}`);
  else if (line.startsWith("warn ")) console.warn(`[earshot] ${line}`);
  else console.info(`[earshot] ${line}`);
};

export function createLogger(
  secrets: () => Iterable<string> = () => [],
  sink: LogSink = consoleSink,
): Logger {
  const logger = createRedactingLogger(sink, secrets);
  return {
    info: (message, detail) =>
      logger.info(message, detail === undefined ? undefined : plain(detail)),
    warn: (message, detail) =>
      logger.warn(message, detail === undefined ? undefined : plain(detail)),
    error: (message, detail) =>
      logger.error(message, detail === undefined ? undefined : plain(detail)),
  };
}

/** A logger for one request, which also redacts that request's own secrets. */
export type RequestLogger = Logger & {
  /** Redacts `secret` from every later line. Add each one as soon as the request holds it. */
  addSecret(secret: string | null | undefined): void;
};

/**
 * Wraps `base` for one request. On top of what `base` redacts (the environment's secrets and the
 * shapes of known keys), it redacts what only this request knows: a Deepgram or AssemblyAI key
 * from a header, which no pattern recognizes, the credential minted with it, or a ticket just
 * signed. Log lines carry codes, never these values, so this is the second line of defense.
 */
export function requestLogger(base: Logger): RequestLogger {
  const secrets = new Set<string>();
  const scrub = (detail: unknown): unknown => {
    if (detail === undefined) return undefined;
    const value = plain(detail);
    return JSON.stringify(value) === undefined ? undefined : redactValue(value, secrets);
  };
  return {
    addSecret(secret) {
      const value = secret?.trim();
      if (value) secrets.add(value);
    },
    info: (message, detail) => base.info(redact(message, secrets), scrub(detail)),
    warn: (message, detail) => base.warn(redact(message, secrets), scrub(detail)),
    error: (message, detail) => base.error(redact(message, secrets), scrub(detail)),
  };
}
