// Session tickets for SessionClient: each connect needs a fresh one, because SessionDO accepts a
// ticket's `jti` once (docs/adr/0023). `createTicketFetcher` asks the web app's
// `POST /api/sessions/:id/ticket` (WP3), with the retry machine's bounded retries, and turns its
// refusals into `SessionTicketError`s that say whether reconnecting can help.
import type { TicketRefusal } from "../machines/connection";
import { type WithRetryOptions, withRetry } from "./retry";

/**
 * A ticket for one connection: the fields SessionClient reads from WP3's answers
 * (`SessionTicketResponse`, or `CreateSessionResponse` for the first connect).
 */
export interface SessionTicket {
  readonly ticket: string;
  /** When the edge stops accepting it. */
  readonly ticketExpiresAt?: string;
  /** The session socket's URL, if the answer names one. */
  readonly edgeUrl?: string;
}

/** Why the ticket route refused, as far as the client can act on it. */
export type TicketRouteFailure =
  | "signed_out"
  | "forbidden"
  | "not_found"
  | "session_ended"
  | "rate_limited"
  | "unavailable"
  | "bad_response";

export class SessionTicketError extends Error {
  override readonly name = "SessionTicketError";
  readonly code: TicketRouteFailure;
  readonly retryable: boolean;
  /** For `rate_limited`: how long the route asked to wait. */
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;

  constructor(
    code: TicketRouteFailure,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(`the session ticket request failed: ${code}`, { cause: options.cause });
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = !TICKET_REFUSALS.has(code);
  }

  /** The reason the connection stops, for a refusal reconnecting can't fix. */
  get refusal(): TicketRefusal | undefined {
    switch (this.code) {
      case "signed_out":
      case "forbidden":
      case "not_found":
      case "session_ended":
        return this.code;
      default:
        return undefined;
    }
  }
}

const TICKET_REFUSALS: ReadonlySet<TicketRouteFailure> = new Set([
  "signed_out",
  "forbidden",
  "not_found",
  "session_ended",
]);

export interface TicketFetcherOptions {
  readonly sessionId: string;
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Prefixed to `/api/sessions/...`; empty for the page's own origin. */
  readonly baseUrl?: string;
  /** Bounded retries within one connect: the retry machine's targets by default. */
  readonly retry?: Omit<WithRetryOptions, "signal" | "classify">;
}

/** The function SessionClient calls for a fresh ticket before every connect. */
export function createTicketFetcher(
  options: TicketFetcherOptions,
): (signal: AbortSignal) => Promise<SessionTicket> {
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const url = `${options.baseUrl ?? ""}/api/sessions/${encodeURIComponent(options.sessionId)}/ticket`;
  const once = async (signal: AbortSignal): Promise<SessionTicket> => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SessionTicketError("unavailable", { cause: error });
    }
    if (!response.ok) throw await refusalFrom(response);
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new SessionTicketError("bad_response", { status: response.status, cause: error });
    }
    const ticket = readTicket(body, options.sessionId);
    if (!ticket) throw new SessionTicketError("bad_response", { status: response.status });
    return ticket;
  };
  return (signal) =>
    withRetry((attemptSignal) => once(attemptSignal), { ...options.retry, signal });
}

function readTicket(body: unknown, sessionId: string): SessionTicket | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { ticket, ticketExpiresAt, edgeUrl, sessionId: answered } = body as Record<string, unknown>;
  if (typeof ticket !== "string" || ticket.length === 0) return undefined;
  if (answered !== undefined && answered !== sessionId) return undefined;
  return {
    ticket,
    ...(typeof ticketExpiresAt === "string" ? { ticketExpiresAt } : {}),
    ...(typeof edgeUrl === "string" ? { edgeUrl } : {}),
  };
}

async function refusalFrom(response: Response): Promise<SessionTicketError> {
  const status = response.status;
  switch (status) {
    case 401:
      return new SessionTicketError("signed_out", { status });
    case 403:
      return new SessionTicketError("forbidden", { status });
    case 404:
      return new SessionTicketError("not_found", { status });
    case 409:
      return new SessionTicketError("session_ended", { status });
    case 429: {
      const retryAfterMs = await retryAfter(response);
      return new SessionTicketError("rate_limited", {
        status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }
    default:
      return new SessionTicketError("unavailable", { status });
  }
}

/** The route's `retryAfterSeconds`, or else its `Retry-After` header, in ms. */
async function retryAfter(response: Response): Promise<number | undefined> {
  try {
    const body = (await response.clone().json()) as { retryAfterSeconds?: unknown } | null;
    const seconds = body?.retryAfterSeconds;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
  } catch {
    // Not JSON: fall back to the header.
  }
  const header = response.headers.get("retry-after");
  const seconds = header === null || header.trim() === "" ? Number.NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}
