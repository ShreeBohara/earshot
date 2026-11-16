import { createRedactingLogger, type Logger, type LogSink } from "@earshot/keys/server";

/**
 * The server's logger. Every line goes through @earshot/keys' redaction: the secrets passed in
 * (the auth secret, provider client secrets, the email API key, the database URL) and anything
 * shaped like a provider key come out as [REDACTED]. Never pass magic links, session tokens, or
 * email addresses: redaction can't recognize those, so callers keep them out (docs/adr/0006).
 */
export type { Logger };

/** Errors serialize to `{}`; keep their name and message instead (both still get redacted). */
function plain(detail: unknown): unknown {
  if (detail instanceof Error) return { name: detail.name, message: detail.message };
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
