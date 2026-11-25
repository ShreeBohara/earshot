// The JSON the session and voice-token routes answer with (docs/adr/0023), for the routes and
// for the browser code that calls them. Pure types: no server or browser imports.
import type { EntityRef, PolicySnapshot } from "@earshot/core";

/** Speech-to-text providers whose temporary credentials `POST /api/voice/token` mints. */
export type MintProvider = "assemblyai" | "deepgram";

/** Keyterms for each speech-to-text provider, best first, already within its limits. */
export type SessionKeyterms = { assemblyai: string[]; deepgram: string[] };

/** `POST /api/sessions`, 201: the session exists, and its first ticket is ready. */
export type CreateSessionResponse = {
  sessionId: string;
  /** For one connection: offer it as `earshot.ticket.<ticket>`, next to `earshot.v1`. */
  ticket: string;
  /** When the edge stops accepting the ticket. After that, ask `…/ticket` for a fresh one. */
  ticketExpiresAt: string;
  /** The session socket's URL: `wss://<edge>/v1/sessions/<sessionId>/ws`. */
  edgeUrl: string;
  /**
   * The CRM records the session may mention, best first, each contact and deal with its company
   * as `parentId`. Send them unchanged in `start`: the list is cut to fit that message's 64 KiB,
   * given the providers this request named.
   */
  entities: EntityRef[];
  /**
   * The account open in Earshot: the request's `selectedAccountId`, when it's a company among
   * `entities`, else null. Send it in `start` as `focusEntityId`; the linker reads it as context.
   */
  focusEntityId: string | null;
  keyterms: SessionKeyterms;
  /**
   * The workspace's approval policy, signed for this session (Phase 5 WP11): send it unchanged in
   * `start` as `policy`. SessionDO checks the signature against the session and applies the
   * policy to this session's proposals only. Null when the workspace has no policy, or one that
   * approves nothing: every proposal waits for the rep.
   */
  policy: PolicySnapshot | null;
};

/** `POST /api/sessions/:id/ticket`: a fresh ticket for reconnecting to an open session. */
export type SessionTicketResponse = {
  sessionId: string;
  ticket: string;
  ticketExpiresAt: string;
  edgeUrl: string;
};

/** `POST /api/voice/token`: a provider's temporary credential, minted from the user's key. */
export type VoiceTokenResponse = {
  provider: MintProvider;
  /**
   * The temporary credential: AssemblyAI's token (`?token=` on its socket) or Deepgram's grant
   * JWT (the `["bearer", jwt]` subprotocol). Never the key itself.
   */
  credential: string;
  /** When the provider stops accepting it for a new connection (30–60 s after minting). */
  expiresAt: string;
  /**
   * The base the speech-to-text adapter appends its own path and query to: the provider's
   * WebSocket origin when the browser connects directly (`wss://streaming.assemblyai.com`,
   * `wss://api.deepgram.com`), or a relay's base URL if WP1 finds Deepgram needs one.
   */
  url: string;
};

/**
 * Why a session or token route refused a request: a fixed code, so nothing from the request (a
 * key pasted into the wrong place, say) is ever echoed back. The provider failures are the codes
 * the key routes use.
 */
export type VoiceRouteError =
  | "unauthorized"
  | "forbidden"
  | "too_many_requests"
  | "invalid_request"
  | "unknown_provider"
  | "missing_key"
  | "not_found"
  | "session_ended"
  | "rejected"
  | "rate_limited"
  | "upstream_error"
  | "unreachable"
  | "server_error";

/** The body of every refusal: a code, a fixed sentence, and for 429 how long to wait. */
export type VoiceRouteErrorBody = {
  error: VoiceRouteError;
  message: string;
  retryAfterSeconds?: number;
};
