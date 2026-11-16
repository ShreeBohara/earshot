// Session tickets, as the web app issues them (spec §4.3, docs/adr/0023): one per socket
// connection, signed with EARSHOT_SESSION_TICKET_SECRET by @earshot/core's `signTicket`. The edge
// Worker verifies the signature, the expiry, and that `sid` matches the socket's URL; SessionDO
// refuses a `jti` it has seen and pins `uid` and `wid` on the first connection.
import { signTicket, ticketClaims } from "@earshot/core";

export type IssuedTicket = {
  /** `payload.signature`, for the `earshot.ticket.<ticket>` subprotocol entry. */
  ticket: string;
  /** When the edge stops accepting it: 60 s after issue, plus at most 5 s of clock skew. */
  expiresAt: Date;
};

/**
 * Signs a ticket for one connection to `sessionId` by this user in this workspace, with a fresh
 * `jti` and the longest lifetime the contract allows (60 s). The caller has already checked that
 * the session is the user's, in this workspace, and still open.
 */
export async function issueTicket(
  secret: string,
  input: { sessionId: string; userId: string; workspaceId: string; now: Date },
): Promise<IssuedTicket> {
  const claims = ticketClaims({
    sid: input.sessionId,
    uid: input.userId,
    wid: input.workspaceId,
    now: input.now,
  });
  return { ticket: await signTicket(secret, claims), expiresAt: new Date(claims.exp * 1000) };
}

/**
 * Where the browser opens a session's socket: `${edgeOrigin}/v1/sessions/${id}/ws`, a `wss:` URL
 * (or `ws:` for localhost). The ticket travels in `Sec-WebSocket-Protocol`, never in the URL.
 */
export function sessionSocketUrl(edgeOrigin: string, sessionId: string): string {
  return `${edgeOrigin}/v1/sessions/${encodeURIComponent(sessionId)}/ws`;
}
