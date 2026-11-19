// The speech-to-text adapter interface (spec §4.1). Adapters are thin, hand-written WebSocket
// clients with no SDK: they connect with a temporary credential minted by `POST /api/voice/token`,
// send 16 kHz PCM16, and turn the provider's messages into partials and `utterance.final`
// payloads on the session's audio clock.
import type { UtteranceFinalV2 } from "@earshot/core";

export type SttAdapterId = "assemblyai" | "deepgram-nova3" | "deepgram-flux" | "fake";

/** The providers `POST /api/voice/token` mints for: its `x-earshot-provider` header values. */
export type TempCredentialProvider = "assemblyai" | "deepgram";

/**
 * A short-lived provider credential: exactly the body `POST /api/voice/token` answers with, so the
 * route's response passes straight through. Mint a fresh one for every connect and reconnect; it
 * only has to be valid at the handshake. One Deepgram credential serves Nova-3 and Flux alike.
 */
export interface TempCredential {
  readonly provider: TempCredentialProvider;
  /** AssemblyAI's streaming token, or Deepgram's grant JWT. Never log it. */
  readonly credential: string;
  /** When it stops opening sockets (ISO 8601). */
  readonly expiresAt: string;
  /**
   * The provider's base URL, such as `wss://streaming.assemblyai.com` or `wss://api.deepgram.com`
   * (or a relay's). The adapter appends its own path and query: `/v3/ws`, `/v1/listen`, or
   * `/v2/listen`.
   */
  readonly url: string;
}

export interface SttLimits {
  /** The most keyterms sent; a longer list is cut to its first terms, which rank highest. */
  readonly maxKeyterms: number;
  /** Longer keyterms are dropped, not cut, since half a name biases toward the wrong one. */
  readonly maxKeytermChars?: number;
  /** A conservative budget for the provider's total keyterm tokens (Deepgram's 500). */
  readonly maxKeytermTokens?: number;
  /** The audio per message, in ms. */
  readonly chunkMs: number;
}

export interface SttConnectOptions {
  readonly credential: TempCredential;
  readonly keyterms: readonly string[];
  /**
   * Where this socket's audio starts on the session's audio clock, in ms. Provider times are
   * relative to the socket's first sample, so session time is `baseOffsetMs` plus provider time.
   */
  readonly baseOffsetMs: number;
  /** Aborting it before the socket opens rejects `connect` and closes the socket. */
  readonly signal?: AbortSignal;
}

export interface SttAdapter {
  readonly id: SttAdapterId;
  /** The provider and model as the price table names them, for `usage` events. */
  readonly provider: string;
  readonly model: string;
  readonly limits: SttLimits;
  /** Resolves once the socket is open. Rejects with an `SttConnectError`. */
  connect(opts: SttConnectOptions): Promise<SttConnection>;
}

export interface SttConnection {
  /**
   * Sends PCM16 audio. Successive calls must be contiguous session audio, starting at the
   * connection's `baseOffsetMs`; dropped silently once the socket has closed.
   */
  send(pcm16: Int16Array): void;
  /** Ends the current turn now: ForceEndpoint, Finalize, or ForceEndTurn. */
  finalize(): void;
  /** Replaces the keyterm list: UpdateConfiguration or Configure. Rejects if the provider refuses. */
  updateKeyterms(terms: readonly string[]): Promise<void>;
  /** Keeps an idle socket open between presses. */
  keepAlive(): void;
  /** Ends the stream gracefully, waits briefly for the provider's usage report, then closes. */
  close(): Promise<SttUsage>;
  on(listener: (event: SttEvent) => void): () => void;
}

/** One socket's usage. Provider-reported numbers win over the client's own count. */
export interface SttUsage {
  readonly provider: string;
  readonly model: string;
  /** Audio sent, in ms. */
  readonly audioMs: number;
  /** How long the socket was open, in ms. */
  readonly socketMs: number;
  /** Where the numbers came from: the provider's report (AssemblyAI's Termination), or the client. */
  readonly source: "provider" | "client";
}

/**
 * Why a connection failed or broke:
 * - `unauthorized`: the provider refused the credential.
 * - `rate_limited`: too many streams or messages.
 * - `bad_request`: the provider refused the request or a message.
 * - `keyterms_rejected`: a keyterm update was refused.
 * - `provider_error`: the provider reported an error.
 * - `connection_failed`: the socket never opened. Browsers hide the HTTP status of a failed
 *   handshake, so a bad credential, a network failure, and an `Origin` refusal all look alike.
 * - `connection_lost`: the socket closed unexpectedly after opening.
 * - `timeout`: the socket didn't open in time.
 */
export type SttErrorCode =
  | "unauthorized"
  | "rate_limited"
  | "bad_request"
  | "keyterms_rejected"
  | "provider_error"
  | "connection_failed"
  | "connection_lost"
  | "timeout";

export type SttEvent =
  /** A live transcript of the turn so far, in session audio ms. */
  | {
      readonly type: "partial";
      readonly text: string;
      readonly startMs: number;
      readonly endMs: number;
    }
  /** A final segment, on the session's audio clock. */
  | { readonly type: "final"; readonly utterance: UtteranceFinalV2 }
  /**
   * The provider closed a turn: after `finalize()`, or by its own endpointing. Any finals for the
   * turn come before it.
   */
  | { readonly type: "end_of_turn" }
  | {
      readonly type: "error";
      readonly code: SttErrorCode;
      /** For logs only. It never contains the credential. */
      readonly message: string;
      /** Whether the socket is gone. Non-fatal errors leave it usable. */
      readonly fatal: boolean;
    }
  /** The socket closed, cleanly or not. Always the last event. */
  | {
      readonly type: "closed";
      readonly code: number;
      readonly expected: boolean;
      readonly usage: SttUsage;
    };

/** Why `connect` failed. `retryAfterMs` is set when the provider asked for a pause. */
export class SttConnectError extends Error {
  readonly code: SttErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: SttErrorCode,
    message: string,
    options: { retryable: boolean; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SttConnectError";
    this.code = code;
    this.retryable = options.retryable;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}
