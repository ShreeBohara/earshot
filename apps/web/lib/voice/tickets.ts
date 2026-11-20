// Session tickets, as the web app issues them (spec §4.3, docs/adr/0023): one per socket
// connection, signed with EARSHOT_SESSION_TICKET_SECRET by @earshot/core's `signTicket`. The edge
// Worker verifies the signature, the expiry, and that `sid` matches the socket's URL; SessionDO
// refuses a `jti` it has seen and pins `uid` and `wid` on the first connection.
import { type SignInMethod, signTicket, ticketClaims } from "@earshot/core";

export type IssuedTicket = {
  /** `payload.signature`, for the `earshot.ticket.<ticket>` subprotocol entry. */
  ticket: string;
  /** When the edge stops accepting it: 60 s after issue, plus at most 5 s of clock skew. */
  expiresAt: Date;
};

/**
 * Signs a ticket for one connection to `sessionId` by this user in this workspace, with a fresh
 * `jti` and the longest lifetime the contract allows (60 s). The caller has already checked that
 * the session is the user's, in this workspace, and still open. `signIn` is how and when the
 * viewer's web session signed in: it becomes the `am` and `sat` claims (whole seconds), which
 * SessionDO records on each review the socket sends (Phase 5 WP3).
 */
export async function issueTicket(
  secret: string,
  input: {
    sessionId: string;
    userId: string;
    workspaceId: string;
    now: Date;
    signIn?: { method: SignInMethod; at: Date };
  },
): Promise<IssuedTicket> {
  const claims = ticketClaims({
    sid: input.sessionId,
    uid: input.userId,
    wid: input.workspaceId,
    now: input.now,
    ...(input.signIn ? { signIn: signInClaim(input.signIn, input.now) } : {}),
  });
  return { ticket: await signTicket(secret, claims), expiresAt: new Date(claims.exp * 1000) };
}

/**
 * The sign-in as the ticket claims it. `sat` may not run past the ticket's own time by more than
 * the clock skew the claims allow, so a sign-in stamped a moment ahead of this Worker's clock (two
 * databases' clocks) is claimed at the ticket's time instead of failing the ticket.
 */
function signInClaim(signIn: { method: SignInMethod; at: Date }, now: Date) {
  return { method: signIn.method, at: signIn.at.getTime() > now.getTime() ? now : signIn.at };
}

/**
 * Where the browser opens a session's socket: `${edgeOrigin}/v1/sessions/${id}/ws`, a `wss:` URL
 * (or `ws:` for localhost). The ticket travels in `Sec-WebSocket-Protocol`, never in the URL.
 */
export function sessionSocketUrl(edgeOrigin: string, sessionId: string): string {
  return `${edgeOrigin}/v1/sessions/${encodeURIComponent(sessionId)}/ws`;
}
