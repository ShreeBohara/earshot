// AssemblyAI Universal-Streaming, v3 (spec WP4 step 4). The default adapter: the cheapest list
// price, billed on the time the socket is open, idle included, so the engine reuses one socket
// across presses and closes it after 20 s idle. The free tier also allows only 5 new streams a
// minute.
//
// Wire format, from AssemblyAI's v3 streaming docs (research note stt_providers.md §1–§5):
// - Connect: ${url}/v3/ws?token=…&sample_rate=16000&encoding=pcm_s16le, where `url` is the base
//   the token route answers with (wss://streaming.assemblyai.com), with keyterms_prompt as a
//   JSON-encoded array. Browsers can't set headers, so the token rides in the URL; never log it.
// - Send: binary PCM16; {"type":"UpdateConfiguration","keyterms_prompt":[…]} (replaces the whole
//   list); {"type":"ForceEndpoint"}; {"type":"KeepAlive"}; {"type":"Terminate"}.
// - Receive: Begin; Turn (transcript, end_of_turn, turn_is_formatted, turn_order, and words with
//   text, start, end, confidence, word_is_final, times in ms); Termination (audio_duration_seconds,
//   session_duration_seconds).
//
// Settled by WP1, not here: which parameter selects Universal-Streaming English (`speechModel`),
// whether to wait for formatted turns (`formatTurns`), and the close codes for a refused token or
// the free tier's stream limit.
import { TARGET_SAMPLE_RATE } from "../capture/dsp";
import type { SttAdapter, SttConnection, SttConnectOptions, SttLimits } from "./adapter";
import {
  type CloseMeaning,
  type ConnectionSettings,
  numberField,
  recordsField,
  stringField,
  WebSocketSttConnection,
} from "./connection";
import { providerSocketUrl } from "./credential";
import { ASSEMBLYAI_KEYTERM_LIMITS, prepareKeyterms } from "./keyterms";
import { type ProviderWord, toUtterances } from "./normalize";
import { type Clock, createBrowserSocket, type SocketFactory, systemClock } from "./socket";

/** The base URL the token route answers with; the adapter appends ASSEMBLYAI_PATH. */
export const ASSEMBLYAI_ORIGIN = "wss://streaming.assemblyai.com";
export const ASSEMBLYAI_PATH = "/v3/ws";
/** The price table's name for the model. */
export const ASSEMBLYAI_MODEL = "universal-streaming-english";

export interface AssemblyAiOptions {
  readonly socket?: SocketFactory;
  readonly clock?: Clock;
  readonly createId?: () => string;
  /** The model for usage records and prices. */
  readonly model?: string;
  /** Sent as `speech_model` when set. WP1 confirms the parameter. */
  readonly speechModel?: string;
  /**
   * Ask for formatted turns and emit a final only once the formatted copy arrives. Better text,
   * more latency; WP1 decides. Off by default.
   */
  readonly formatTurns?: boolean;
  /** The server closes a socket that's been silent this long (5–3600 s): a backstop. Default 30. */
  readonly inactivityTimeoutSeconds?: number;
  /** Extra query parameters, such as `max_turn_silence`, for tuning. */
  readonly params?: Readonly<Record<string, string>>;
  readonly openTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
}

export function createAssemblyAiAdapter(options: AssemblyAiOptions = {}): SttAdapter {
  const settings: ConnectionSettings = {
    socket: options.socket ?? createBrowserSocket,
    clock: options.clock ?? systemClock,
    ...(options.createId ? { createId: options.createId } : {}),
    openTimeoutMs: options.openTimeoutMs ?? 10_000,
    closeTimeoutMs: options.closeTimeoutMs ?? 2_000,
  };
  const limits: SttLimits = { ...ASSEMBLYAI_KEYTERM_LIMITS, chunkMs: 64 };
  const model = options.model ?? ASSEMBLYAI_MODEL;
  return {
    id: "assemblyai",
    provider: "assemblyai",
    model,
    limits,
    async connect(opts: SttConnectOptions): Promise<SttConnection> {
      const connection = new AssemblyAiConnection(settings, opts, options, model);
      await connection.opened(opts.signal);
      return connection;
    },
  };
}

/** The connect URL. Exported for tests; it carries the token, so never log it. */
export function assemblyAiUrl(opts: SttConnectOptions, options: AssemblyAiOptions): string {
  const url = providerSocketUrl(opts.credential, "assemblyai", ASSEMBLYAI_PATH);
  const params = url.searchParams;
  params.set("sample_rate", String(TARGET_SAMPLE_RATE));
  params.set("encoding", "pcm_s16le");
  params.set("format_turns", String(options.formatTurns ?? false));
  params.set("inactivity_timeout", String(options.inactivityTimeoutSeconds ?? 30));
  if (options.speechModel) params.set("speech_model", options.speechModel);
  const { terms } = prepareKeyterms(opts.keyterms, ASSEMBLYAI_KEYTERM_LIMITS);
  if (terms.length > 0) params.set("keyterms_prompt", JSON.stringify(terms));
  for (const [key, value] of Object.entries(options.params ?? {})) params.set(key, value);
  params.set("token", opts.credential.credential);
  return url.toString();
}

class AssemblyAiConnection extends WebSocketSttConnection {
  readonly #formatTurns: boolean;
  #lastFinalTurn: number | undefined;

  constructor(
    settings: ConnectionSettings,
    opts: SttConnectOptions,
    options: AssemblyAiOptions,
    model: string,
  ) {
    super(settings, {
      url: assemblyAiUrl(opts, options),
      provider: "assemblyai",
      model,
      baseOffsetMs: opts.baseOffsetMs,
    });
    this.#formatTurns = options.formatTurns ?? false;
  }

  finalize(): void {
    this.sendJson({ type: "ForceEndpoint" });
  }

  keepAlive(): void {
    this.sendJson({ type: "KeepAlive" });
  }

  async updateKeyterms(terms: readonly string[]): Promise<void> {
    const plan = prepareKeyterms(terms, ASSEMBLYAI_KEYTERM_LIMITS);
    // AssemblyAI documents no acknowledgement, so this resolves once sent.
    this.sendJson({ type: "UpdateConfiguration", keyterms_prompt: plan.terms });
  }

  protected sendTerminate(): void {
    this.sendJson({ type: "Terminate" });
  }

  protected handleMessage(message: Record<string, unknown>): void {
    switch (message.type) {
      case "Turn":
        this.#onTurn(message);
        return;
      case "Termination": {
        const audio = numberField(message, "audio_duration_seconds");
        const session = numberField(message, "session_duration_seconds");
        this.reportUsage({
          ...(audio === undefined ? {} : { audioMs: audio * 1000 }),
          ...(session === undefined ? {} : { socketMs: session * 1000 }),
        });
        return;
      }
      case "Begin":
        return;
      default: {
        const error = stringField(message, "error");
        if (error !== undefined) {
          this.emit({ type: "error", code: "provider_error", message: error, fatal: false });
        }
      }
    }
  }

  protected closeMeaning(code: number): CloseMeaning {
    if (code === 1008 || code === 4001 || code === 4003) {
      return { code: "unauthorized", retryable: true };
    }
    if (code === 4002) return { code: "unauthorized", retryable: false }; // insufficient funds
    if (code === 4029 || code === 4429 || code === 1013) {
      return { code: "rate_limited", retryable: true, retryAfterMs: 12_000 };
    }
    if (code >= 4000 && code < 5000) return { code: "provider_error", retryable: true };
    return { code: "connection_lost", retryable: true };
  }

  #onTurn(message: Record<string, unknown>): void {
    const words: ProviderWord[] = recordsField(message, "words").map((word) => ({
      text: stringField(word, "text") ?? "",
      startMs: numberField(word, "start") ?? 0,
      endMs: numberField(word, "end") ?? 0,
      confidence: numberField(word, "confidence") ?? 0,
    }));
    if (message.end_of_turn !== true) {
      const text = (
        words.length > 0
          ? words.map((word) => word.text).join(" ")
          : stringField(message, "transcript")
      )?.trim();
      if (text) {
        const first = words[0];
        const last = words.at(-1);
        this.emit({
          type: "partial",
          text,
          startMs: Math.round(this.toSessionMs(first?.startMs ?? 0)),
          endMs: Math.round(this.toSessionMs(last?.endMs ?? first?.startMs ?? 0)),
        });
      }
      return;
    }
    // With formatting on, the unformatted end of turn comes first; the formatted copy follows.
    if (this.#formatTurns && message.turn_is_formatted !== true) return;
    const turnOrder = numberField(message, "turn_order");
    if (turnOrder !== undefined && turnOrder === this.#lastFinalTurn) return;
    this.#lastFinalTurn = turnOrder;
    const utterances = toUtterances(words, {
      toSessionMs: (ms) => this.toSessionMs(ms),
      text: stringField(message, "transcript") ?? stringField(message, "utterance") ?? "",
      ...(this.createId ? { createId: this.createId } : {}),
    });
    for (const utterance of utterances) this.emit({ type: "final", utterance });
    this.emit({ type: "end_of_turn" });
  }
}
