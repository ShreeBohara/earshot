import { errorSummary, type Logger, scrubMessage } from "../log";

type BetterAuthLogLevel = "debug" | "info" | "warn" | "error";

/**
 * Better Auth's `logger.log` hook. Better Auth passes extra arguments with some lines: errors
 * (whose messages can quote queries, emails, or tokens), and sometimes objects built from the
 * request. None of those reach the log as they are. A line keeps its level and its message,
 * scrubbed (secret shapes redacted, email addresses and long tokens masked), and for each `Error`
 * argument only its name and code.
 */
export function betterAuthLog(log: Logger) {
  return (level: BetterAuthLogLevel, message: unknown, ...args: unknown[]): void => {
    const errors = args
      .map(errorSummary)
      .filter((summary) => summary !== undefined && (summary.name || summary.code));
    const detail = errors.length > 0 ? { errors } : undefined;
    const line = `better-auth: ${scrubMessage(message)}`;
    if (level === "error") log.error(line, detail);
    else if (level === "warn") log.warn(line, detail);
    else log.info(line, detail);
  };
}
