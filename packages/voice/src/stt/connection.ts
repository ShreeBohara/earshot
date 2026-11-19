// What every WebSocket adapter shares: opening with a timeout and an abort signal, JSON message
// dispatch, the provider-to-session time map, usage accounting, and a graceful close that waits
// briefly for the provider's own usage report.
import { TARGET_SAMPLE_RATE } from "../capture/dsp";
import {
  SttConnectError,
  type SttConnection,
  type SttErrorCode,
  type SttEvent,
  type SttUsage,
} from "./adapter";
import { type Clock, SOCKET_OPEN, type SocketFactory, type SocketLike } from "./socket";

const SAMPLES_PER_MS = TARGET_SAMPLE_RATE / 1000;

export interface ConnectionSettings {
  readonly socket: SocketFactory;
  readonly clock: Clock;
  readonly createId?: () => string;
  /** How long the handshake may take. */
  readonly openTimeoutMs: number;
  /** How long `close()` waits for the provider to finish before closing the socket itself. */
  readonly closeTimeoutMs: number;
}

export interface ConnectionTarget {
  readonly url: string;
  readonly protocols?: readonly string[];
  readonly provider: string;
  readonly model: string;
  readonly baseOffsetMs: number;
}

/** How a close code reads: an error code, and whether a fresh connection might work. */
export interface CloseMeaning {
  readonly code: SttErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

type State = "connecting" | "open" | "closed";

export abstract class WebSocketSttConnection implements SttConnection {
  protected readonly socket: SocketLike;
  protected readonly clock: Clock;
  protected readonly createId: (() => string) | undefined;
  protected readonly baseOffsetMs: number;
  readonly provider: string;
  readonly model: string;
  readonly #settings: ConnectionSettings;
  readonly #listeners = new Set<(event: SttEvent) => void>();
  #state: State = "connecting";
  #samplesSent = 0;
  /** Silence the connection sent on its own (a keepalive), in provider samples. */
  readonly #insertedSilence: { at: number; samples: number }[] = [];
  #silenceSamples = 0;
  #openedAt: number | undefined;
  #closedAt: number | undefined;
  #closeRequested = false;
  #providerUsage: { audioMs?: number; socketMs?: number } | undefined;
  #closing: Promise<SttUsage> | undefined;
  #resolveClose: ((usage: SttUsage) => void) | undefined;
  #closeTimers: unknown[] = [];
  #opening:
    | { resolve: () => void; reject: (error: unknown) => void; timer: unknown; abort?: () => void }
    | undefined;

  constructor(settings: ConnectionSettings, target: ConnectionTarget) {
    this.#settings = settings;
    this.clock = settings.clock;
    this.createId = settings.createId;
    this.baseOffsetMs = target.baseOffsetMs;
    this.provider = target.provider;
    this.model = target.model;
    try {
      this.socket = settings.socket(target.url, target.protocols);
    } catch (error) {
      throw new SttConnectError("bad_request", "the socket couldn't be created", {
        retryable: false,
        cause: error,
      });
    }
    this.socket.onopen = () => this.#onOpen();
    this.socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof message === "object" && message !== null) {
        this.handleMessage(message as Record<string, unknown>);
      }
    };
    this.socket.onerror = () => {}; // a close event always follows, with the code
    this.socket.onclose = (event) => this.#onClose(event.code, event.reason);
  }

  /** Resolves once the socket opens; rejects with an `SttConnectError`, or the signal's reason. */
  opened(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.#state === "open") {
        resolve();
        return;
      }
      if (this.#state === "closed") {
        reject(new SttConnectError("connection_failed", "the socket closed", { retryable: true }));
        return;
      }
      if (signal?.aborted) {
        this.#abandon();
        reject(signal.reason);
        return;
      }
      const timer = this.clock.setTimeout(() => {
        this.#opening = undefined;
        this.#abandon();
        reject(
          new SttConnectError("timeout", "the socket didn't open in time", { retryable: true }),
        );
      }, this.#settings.openTimeoutMs);
      const onAbort = () => {
        this.clock.clearTimeout(timer);
        this.#opening = undefined;
        this.#abandon();
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#opening = {
        resolve,
        reject,
        timer,
        abort: () => signal?.removeEventListener("abort", onAbort),
      };
    });
  }

  on(listener: (event: SttEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get isOpen(): boolean {
    return this.#state === "open" && this.socket.readyState === SOCKET_OPEN;
  }

  send(pcm16: Int16Array): void {
    if (!this.isOpen || pcm16.length === 0) return;
    this.socket.send(pcm16);
    this.#samplesSent += pcm16.length;
  }

  abstract finalize(): void;
  abstract updateKeyterms(terms: readonly string[]): Promise<void>;
  abstract keepAlive(): void;

  close(): Promise<SttUsage> {
    if (this.#closing) return this.#closing;
    this.#closeRequested = true;
    this.#closing = new Promise<SttUsage>((resolve) => {
      this.#resolveClose = resolve;
    });
    if (this.#state === "closed") {
      this.#finishClose();
    } else if (this.isOpen) {
      this.sendTerminate();
      this.#closeTimers.push(
        this.clock.setTimeout(() => this.#forceClose(), this.#settings.closeTimeoutMs),
      );
    } else {
      this.#forceClose();
    }
    return this.#closing;
  }

  // ---- for providers ----

  /** Handles one parsed JSON message from the provider. */
  protected abstract handleMessage(message: Record<string, unknown>): void;
  /** Asks the provider to end the stream and report usage (Terminate or CloseStream). */
  protected abstract sendTerminate(): void;
  /** What a close code means, for this provider. */
  protected abstract closeMeaning(code: number, reason: string): CloseMeaning;

  protected emit(event: SttEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  protected sendJson(message: object): void {
    if (this.isOpen) this.socket.send(JSON.stringify(message));
  }

  /** Sends silence that isn't session audio, and maps provider time around it. */
  protected sendSilence(samples: number): void {
    if (!this.isOpen || samples <= 0) return;
    this.#insertedSilence.push({ at: this.#samplesSent + this.#silenceSamples, samples });
    this.#silenceSamples += samples;
    this.socket.send(new Int16Array(samples));
  }

  /** Provider time (ms from this socket's first sample) to session audio ms. */
  protected toSessionMs(providerMs: number): number {
    const providerSample = providerMs * SAMPLES_PER_MS;
    let removed = 0;
    for (const silence of this.#insertedSilence) {
      if (providerSample <= silence.at) break;
      removed += Math.min(silence.samples, providerSample - silence.at);
    }
    return this.baseOffsetMs + (providerSample - removed) / SAMPLES_PER_MS;
  }

  /** Records the provider's own usage report, which `close()` prefers. */
  protected reportUsage(usage: { audioMs?: number; socketMs?: number }): void {
    this.#providerUsage = { ...this.#providerUsage, ...usage };
  }

  /** The socket closes itself after this, if the provider hasn't already. */
  protected usage(): SttUsage {
    const clientAudioMs = Math.round((this.#samplesSent + this.#silenceSamples) / SAMPLES_PER_MS);
    const clientSocketMs =
      this.#openedAt === undefined
        ? 0
        : Math.max(0, Math.round((this.#closedAt ?? this.clock.now()) - this.#openedAt));
    const reported = this.#providerUsage;
    if (reported && (reported.audioMs !== undefined || reported.socketMs !== undefined)) {
      return {
        provider: this.provider,
        model: this.model,
        audioMs: Math.max(0, Math.round(reported.audioMs ?? clientAudioMs)),
        socketMs: Math.max(0, Math.round(reported.socketMs ?? clientSocketMs)),
        source: "provider",
      };
    }
    return {
      provider: this.provider,
      model: this.model,
      audioMs: clientAudioMs,
      socketMs: clientSocketMs,
      source: "client",
    };
  }

  // ---- internals ----

  #onOpen(): void {
    if (this.#state !== "connecting") return;
    this.#state = "open";
    this.#openedAt = this.clock.now();
    const opening = this.#opening;
    this.#opening = undefined;
    if (opening) {
      this.clock.clearTimeout(opening.timer);
      opening.abort?.();
      opening.resolve();
    }
  }

  #onClose(code: number, reason: string): void {
    if (this.#state === "closed") return;
    const wasOpen = this.#state === "open";
    this.#state = "closed";
    this.#closedAt = this.clock.now();
    const opening = this.#opening;
    this.#opening = undefined;
    if (opening) {
      this.clock.clearTimeout(opening.timer);
      opening.abort?.();
      const meaning = code === 1006 || code === 1005 ? undefined : this.closeMeaning(code, reason);
      opening.reject(
        new SttConnectError(
          meaning?.code ?? "connection_failed",
          `the socket closed before opening (code ${code})`,
          {
            retryable: meaning?.retryable ?? true,
            ...(meaning?.retryAfterMs === undefined ? {} : { retryAfterMs: meaning.retryAfterMs }),
          },
        ),
      );
    }
    const expected = this.#closeRequested;
    if (wasOpen && !expected) {
      const meaning = this.closeMeaning(code, reason);
      this.emit({
        type: "error",
        code: meaning.code,
        message: `the socket closed unexpectedly (code ${code})`,
        fatal: true,
      });
    }
    if (wasOpen) this.emit({ type: "closed", code, expected, usage: this.usage() });
    this.#finishClose();
  }

  #finishClose(): void {
    for (const timer of this.#closeTimers) this.clock.clearTimeout(timer);
    this.#closeTimers = [];
    const resolve = this.#resolveClose;
    this.#resolveClose = undefined;
    resolve?.(this.usage());
  }

  /** Closes the socket ourselves, and stops waiting if its close event never comes. */
  #forceClose(): void {
    if (this.#state === "closed") return;
    try {
      this.socket.close(1000, "client closing");
    } catch {
      // already closing
    }
    this.#closeTimers.push(
      this.clock.setTimeout(() => this.#onClose(1006, "close timed out"), 1_000),
    );
  }

  /** Gives up on a socket that hasn't opened. */
  #abandon(): void {
    this.#closeRequested = true;
    try {
      this.socket.close(1000, "client closing");
    } catch {
      // never opened
    }
  }
}

/** A string field of a provider message, or undefined. */
export function stringField(message: Record<string, unknown>, key: string): string | undefined {
  const value = message[key];
  return typeof value === "string" ? value : undefined;
}

/** A finite number field of a provider message, or undefined. */
export function numberField(message: Record<string, unknown>, key: string): number | undefined {
  const value = message[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** An array field of a provider message, as records, skipping anything else. */
export function recordsField(
  message: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  const value = message[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
  );
}
