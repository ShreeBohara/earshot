// The edge Worker's HTTP surface (Hono): the health check, and the session socket's front door.
import {
  SESSION_SUBPROTOCOL,
  TICKET_SUBPROTOCOL_PREFIX,
  ticketFromSubprotocols,
  verifyTicket,
} from "@earshot/core";
import { type Context, Hono } from "hono";
import { EdgeConfigError, isAllowedOrigin, readEdgeConfig } from "./config";
import { createLogger } from "./log";
import { CLAIMS_HEADER, refuseSocket } from "./socket";

type Edge = { Bindings: Env };

/** A session id as the web app issues them: a UUID in lowercase, the only form Postgres returns. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createApp(): Hono<Edge> {
  const app = new Hono<Edge>();

  app.get("/health", async (c) => {
    const stub = c.env.SESSION.get(c.env.SESSION.idFromName("health"));
    const ping = await stub.ping();
    return c.json({
      status: "ok",
      durableObject: ping.ok ? "ok" : "error",
      env: c.env.DEPLOY_ENV,
      version: c.env.GIT_SHA,
    });
  });

  app.get("/v1/sessions/:id/ws", sessionSocket);

  return app;
}

/**
 * `GET /v1/sessions/:id/ws` (spec §4.3, WP6 step 1). Checks, in order:
 *
 * 1. `Upgrade: websocket`, else 426.
 * 2. `Origin` is in `WEB_ORIGIN`, else 403: a cross-site page gets no socket at all.
 * 3. The client offers `earshot.v1`, else the socket closes with `unsupported_protocol`.
 * 4. The ticket in `Sec-WebSocket-Protocol` verifies (HMAC, version, lifetime, expiry) and names
 *    this session, else the socket closes with `ticket_refused`.
 *
 * Then the request goes to the session's Durable Object, with the verified claims in an internal
 * header on a request built from scratch, so nothing the client sent reaches it. The DO pins the
 * user and workspace, spends the `jti`, and answers the handshake with `earshot.v1` alone, so the
 * ticket is never echoed. Refusals after the handshake close with a code, because a browser can't
 * read the status of a failed WebSocket handshake but can read a close code.
 */
async function sessionSocket(c: Context<Edge, "/v1/sessions/:id/ws">): Promise<Response> {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.text("expected a WebSocket upgrade", 426);
  }

  let config: Awaited<ReturnType<typeof readEdgeConfig>>;
  try {
    config = await readEdgeConfig(c.env);
  } catch (error) {
    // Fail closed. The message names the variable and the fix, never a value.
    const problem = error instanceof EdgeConfigError ? error.message : "unreadable configuration";
    createLogger().error("session socket misconfigured", { problem });
    return c.text("the session service is misconfigured", 500);
  }
  const log = createLogger([config.ticketSecret]);

  if (!isAllowedOrigin(c.req.header("Origin") ?? null, config.webOrigins)) {
    log.warn("session socket refused", { reason: "origin" });
    return c.text("forbidden", 403);
  }

  const sessionId = c.req.param("id");
  if (!SESSION_ID.test(sessionId)) return c.text("not found", 404);

  const offered = c.req.header("Sec-WebSocket-Protocol") ?? "";
  const protocols = offered.split(",").map((entry) => entry.trim());
  if (!protocols.includes(SESSION_SUBPROTOCOL)) {
    log.warn("session socket refused", { close: "unsupported_protocol" });
    return refuseSocket("unsupported_protocol", false);
  }
  const ticket = ticketFromSubprotocols(offered);
  if (!ticket) {
    const tickets = protocols.filter((entry) => entry.startsWith(TICKET_SUBPROTOCOL_PREFIX));
    log.warn("session socket refused", {
      close: "ticket_refused",
      reason: tickets.length > 1 ? "several_tickets" : "no_ticket",
    });
    return refuseSocket("ticket_refused");
  }
  const verified = await verifyTicket(config.ticketKey, ticket, new Date());
  if (!verified.ok) {
    log.warn("session socket refused", { close: "ticket_refused", reason: verified.reason });
    return refuseSocket("ticket_refused");
  }
  if (verified.claims.sid !== sessionId) {
    log.warn("session socket refused", { close: "ticket_refused", reason: "other_session" });
    return refuseSocket("ticket_refused");
  }

  const stub = c.env.SESSION.get(c.env.SESSION.idFromName(sessionId));
  return stub.fetch(
    new Request("https://session.internal/connect", {
      headers: { Upgrade: "websocket", [CLAIMS_HEADER]: JSON.stringify(verified.claims) },
    }),
  );
}
