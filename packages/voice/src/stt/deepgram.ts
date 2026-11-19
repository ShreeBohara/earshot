// What the Nova-3 and Flux adapters share.
//
// Credential: a grant JWT from POST /v1/auth/grant (TTL 30 s by default), valid only at the
// handshake. Deepgram documents no browser transport for JWTs; the WebSocket subprotocol pair
// ["bearer", jwt] was community-verified on /v1/listen in September 2026, and WP1 confirms it on
// both paths. A failed handshake reaches the browser as a bare close 1006, so a refused JWT, a
// network failure, and an Origin refusal look the same here.
//
// Keyterms: one `keyterm` query parameter per term at connect; mid-stream, a Configure message
// with a `keyterms` array, which replaces the list. The server answers ConfigureSuccess or
// ConfigureFailure (CONFIGURE_KEYTERM_LIMIT_EXCEEDED over the limit). Flux documents both answers;
// Nova-3 documents only the failure, so an update with no answer counts as applied after a grace
// period, and a late failure still raises an error event.
import { VoiceError } from "../errors";
import { type CloseMeaning, stringField, WebSocketSttConnection } from "./connection";
import { DEEPGRAM_KEYTERM_LIMITS, prepareKeyterms } from "./keyterms";

/** The base URL the token route answers with; Nova-3 appends /v1/listen and Flux /v2/listen. */
export const DEEPGRAM_ORIGIN = "wss://api.deepgram.com";

/** The subprotocols that carry a grant JWT. */
export function deepgramProtocols(jwt: string): readonly string[] {
  return ["bearer", jwt];
}

/** Adds one `keyterm` parameter per term, after Deepgram's limits. */
export function appendKeyterms(params: URLSearchParams, keyterms: readonly string[]): void {
  for (const term of prepareKeyterms(keyterms, DEEPGRAM_KEYTERM_LIMITS).terms) {
    params.append("keyterm", term);
  }
}

/** Seconds, as Deepgram reports times, to ms. */
export function secondsToMs(seconds: number | undefined): number {
  return seconds === undefined ? 0 : seconds * 1000;
}

export function deepgramCloseMeaning(code: number): CloseMeaning {
  if (code === 1008) return { code: "bad_request", retryable: true }; // DATA-0000: undecodable audio
  if (code === 1011) return { code: "connection_lost", retryable: true }; // NET-0000 / NET-0001
  if (code >= 4000 && code < 5000) return { code: "provider_error", retryable: true };
  return { code: "connection_lost", retryable: true };
}

interface PendingConfigure {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
  timer: unknown;
}

export abstract class DeepgramConnection extends WebSocketSttConnection {
  /** How long an update waits for ConfigureSuccess before it counts as applied. */
  protected configureGraceMs = 3_000;
  readonly #configures: PendingConfigure[] = [];

  async updateKeyterms(terms: readonly string[]): Promise<void> {
    if (!this.isOpen) return;
    const plan = prepareKeyterms(terms, DEEPGRAM_KEYTERM_LIMITS);
    await new Promise<void>((resolve, reject) => {
      const pending: PendingConfigure = { resolve, reject, settled: false, timer: undefined };
      pending.timer = this.clock.setTimeout(() => {
        // Stays queued, so the next reply still pairs with the update it answers.
        if (!pending.settled) {
          pending.settled = true;
          resolve();
        }
      }, this.configureGraceMs);
      this.#configures.push(pending);
      this.sendJson({ type: "Configure", keyterms: plan.terms });
    });
  }

  protected sendTerminate(): void {
    this.sendJson({ type: "CloseStream" });
  }

  protected closeMeaning(code: number): CloseMeaning {
    return deepgramCloseMeaning(code);
  }

  /** Handles ConfigureSuccess and ConfigureFailure; returns false for anything else. */
  protected handleConfigureReply(message: Record<string, unknown>): boolean {
    if (message.type !== "ConfigureSuccess" && message.type !== "ConfigureFailure") return false;
    const pending = this.#configures.shift();
    if (pending) this.clock.clearTimeout(pending.timer);
    if (message.type === "ConfigureFailure") {
      const reason =
        stringField(message, "code") ?? stringField(message, "description") ?? "ConfigureFailure";
      this.emit({ type: "error", code: "keyterms_rejected", message: reason, fatal: false });
      if (pending && !pending.settled) {
        pending.settled = true;
        pending.reject(
          new VoiceError("keyterms_rejected", `Deepgram refused the keyterms: ${reason}`),
        );
      }
    } else if (pending && !pending.settled) {
      pending.settled = true;
      pending.resolve();
    }
    return true;
  }

  /** An Error message from the provider, as a non-fatal error event. */
  protected handleErrorMessage(message: Record<string, unknown>): boolean {
    if (message.type !== "Error") return false;
    const reason =
      stringField(message, "description") ??
      stringField(message, "message") ??
      stringField(message, "code") ??
      "Error";
    this.emit({ type: "error", code: "provider_error", message: reason, fatal: false });
    return true;
  }
}
