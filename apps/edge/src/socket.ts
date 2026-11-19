// Small pieces of the session socket shared by the edge route and SessionDO.
import {
  SESSION_CLOSE_CODES,
  SESSION_SUBPROTOCOL,
  type ServerMessage,
  type SessionCloseName,
  TicketClaims,
} from "@earshot/core";

/**
 * The internal header carrying a verified ticket's claims from the edge route to SessionDO. The
 * route builds the request to the Durable Object from scratch, so no client header reaches it.
 */
export const CLAIMS_HEADER = "x-earshot-ticket-claims";

/** The claims the edge route verified, as SessionDO reads them back; undefined if malformed. */
export function readClaimsHeader(value: string | null): TicketClaims | undefined {
  if (!value) return undefined;
  try {
    const parsed = TicketClaims.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The handshake answer: the socket's client end, speaking `earshot.v1` and nothing else. */
export function upgradeResponse(client: WebSocket): Response {
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: { "Sec-WebSocket-Protocol": SESSION_SUBPROTOCOL },
  });
}

/**
 * Completes the handshake only to close the socket at once with a session close code. A browser
 * can't read an HTTP status from a failed WebSocket, but it can read a close code, so this is how
 * the client learns to fetch a fresh ticket (`ticket_refused`) or stop (`forbidden`).
 */
export function refuseSocket(name: SessionCloseName, subprotocol = true): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  const { code, reason } = SESSION_CLOSE_CODES[name];
  server.close(code, reason);
  if (subprotocol) return upgradeResponse(client);
  return new Response(null, { status: 101, webSocket: client });
}

/** Closes a socket with a session close code. A socket that's already closing is left alone. */
export function closeWith(ws: WebSocket, name: SessionCloseName): void {
  const { code, reason } = SESSION_CLOSE_CODES[name];
  try {
    ws.close(code, reason);
  } catch {
    // Already closed or closing.
  }
}

/** Sends one server message, as JSON. False if the socket was already gone. */
export function sendMessage(ws: WebSocket, message: ServerMessage): boolean {
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}
