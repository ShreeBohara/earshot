// The edge Worker's logger: `createRedactingLogger` from `@earshot/keys/server`, writing to the
// console, which Workers Logs collects. Callers log message types, close and error codes, and
// counts: never a payload, a ticket, or a key (spec WP6 step 10). Redaction is the second line of
// defense: anything shaped like a provider key, and the ticket secret, are masked anyway.
import { createRedactingLogger, type Logger, type LogSink } from "@earshot/keys/server";

export type { Logger };

/** Writes each line at the console level its prefix names (`info`, `warn`, `error`). */
export const consoleSink: LogSink = (line) => {
  if (line.startsWith("error ")) console.error(line);
  else if (line.startsWith("warn ")) console.warn(line);
  else console.log(line);
};

/** A logger that masks `secrets` exactly, plus every key shape `@earshot/keys` knows. */
export function createLogger(secrets: readonly string[] = [], sink: LogSink = consoleSink): Logger {
  return createRedactingLogger(sink, () => secrets);
}
