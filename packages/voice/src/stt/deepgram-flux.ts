// Deepgram Flux on /v2/listen (spec WP4 step 4): model-based turn detection.
//
// Wire format, from Deepgram's Flux reference (research note stt_providers.md §3–§5):
// - Connect: ${url}/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000, where
//   `url` is the token route's base (wss://api.deepgram.com), one `keyterm` per term, with the
//   subprotocols ["bearer", jwt] (untested on /v2 until WP1). The same credential as Nova-3's.
// - Send: binary PCM16; {"type":"Configure","keyterms":[…]} (thresholds too);
//   {"type":"ForceEndTurn"}; {"type":"CloseStream"}.
// - Receive: Connected; TurnInfo with `event` StartOfTurn, Update, EagerEndOfTurn, TurnResumed,
//   or EndOfTurn (`trigger` model, manual, or timeout), plus transcript, turn_index,
//   audio_window_start and audio_window_end, and words with word, start, end, and a `confidence`
//   the schema types as a string; ConfigureSuccess or ConfigureFailure; Error.
//
// Flux documents no KeepAlive message, so `keepAlive()` sends 100 ms of silence, which is valid
// audio on any stream; the connection maps provider times around it. Times are taken as seconds,
// as on /v1; WP1 confirms both.
import { TARGET_SAMPLE_RATE } from "../capture/dsp";
import type { SttAdapter, SttConnection, SttConnectOptions, SttLimits } from "./adapter";
import { type ConnectionSettings, numberField, recordsField, stringField } from "./connection";
import { providerSocketUrl } from "./credential";
import { appendKeyterms, DeepgramConnection, deepgramProtocols, secondsToMs } from "./deepgram";
import { DEEPGRAM_KEYTERM_LIMITS } from "./keyterms";
import { clampConfidence, type ProviderWord, toUtterances } from "./normalize";
import { type Clock, createBrowserSocket, type SocketFactory, systemClock } from "./socket";

export const DEEPGRAM_FLUX_PATH = "/v2/listen";
export const DEEPGRAM_FLUX_MODEL = "flux-general-en";

export interface DeepgramFluxOptions {
  readonly socket?: SocketFactory;
  readonly clock?: Clock;
  readonly createId?: () => string;
  readonly model?: string;
  /** End-of-turn confidence threshold (Deepgram's default is 0.7). */
  readonly eotThreshold?: number;
  /** EagerEndOfTurn threshold; unset leaves eager turns off. */
  readonly eagerEotThreshold?: number;
  /** Silence that ends a turn regardless, in ms (Deepgram's default is 5000). */
  readonly eotTimeoutMs?: number;
  /** Silence sent by `keepAlive()`, in ms. */
  readonly keepAliveSilenceMs?: number;
  readonly redactUsage?: boolean;
  readonly params?: Readonly<Record<string, string>>;
  readonly openTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
}

export function createDeepgramFluxAdapter(options: DeepgramFluxOptions = {}): SttAdapter {
  const settings: ConnectionSettings = {
    socket: options.socket ?? createBrowserSocket,
    clock: options.clock ?? systemClock,
    ...(options.createId ? { createId: options.createId } : {}),
    openTimeoutMs: options.openTimeoutMs ?? 10_000,
    closeTimeoutMs: options.closeTimeoutMs ?? 2_000,
  };
  const limits: SttLimits = { ...DEEPGRAM_KEYTERM_LIMITS, chunkMs: 64 };
  const model = options.model ?? DEEPGRAM_FLUX_MODEL;
  return {
    id: "deepgram-flux",
    provider: "deepgram",
    model,
    limits,
    async connect(opts: SttConnectOptions): Promise<SttConnection> {
      const connection = new FluxConnection(settings, opts, options, model);
      await connection.opened(opts.signal);
      return connection;
    },
  };
}

export function deepgramFluxUrl(opts: SttConnectOptions, options: DeepgramFluxOptions): string {
  const url = providerSocketUrl(opts.credential, "deepgram", DEEPGRAM_FLUX_PATH);
  const params = url.searchParams;
  params.set("model", options.model ?? DEEPGRAM_FLUX_MODEL);
  params.set("encoding", "linear16");
  params.set("sample_rate", String(TARGET_SAMPLE_RATE));
  if (options.eotThreshold !== undefined) params.set("eot_threshold", String(options.eotThreshold));
  if (options.eagerEotThreshold !== undefined) {
    params.set("eager_eot_threshold", String(options.eagerEotThreshold));
  }
  if (options.eotTimeoutMs !== undefined)
    params.set("eot_timeout_ms", String(options.eotTimeoutMs));
  if (options.redactUsage) params.set("redact_usage", "true");
  appendKeyterms(params, opts.keyterms);
  for (const [key, value] of Object.entries(options.params ?? {})) params.set(key, value);
  return url.toString();
}

class FluxConnection extends DeepgramConnection {
  readonly #keepAliveSamples: number;
  #lastEndedTurn: number | undefined;

  constructor(
    settings: ConnectionSettings,
    opts: SttConnectOptions,
    options: DeepgramFluxOptions,
    model: string,
  ) {
    super(settings, {
      url: deepgramFluxUrl(opts, options),
      protocols: deepgramProtocols(opts.credential.credential),
      provider: "deepgram",
      model,
      baseOffsetMs: opts.baseOffsetMs,
    });
    this.#keepAliveSamples = Math.round(
      ((options.keepAliveSilenceMs ?? 100) * TARGET_SAMPLE_RATE) / 1000,
    );
  }

  finalize(): void {
    this.sendJson({ type: "ForceEndTurn" });
  }

  keepAlive(): void {
    this.sendSilence(this.#keepAliveSamples);
  }

  protected handleMessage(message: Record<string, unknown>): void {
    if (this.handleConfigureReply(message) || this.handleErrorMessage(message)) return;
    if (message.type === "TurnInfo") this.#onTurnInfo(message);
    else if (message.type === "Metadata") {
      const duration = numberField(message, "duration");
      if (duration !== undefined) this.reportUsage({ audioMs: duration * 1000 });
    }
  }

  #onTurnInfo(message: Record<string, unknown>): void {
    const words: ProviderWord[] = recordsField(message, "words").map((word) => ({
      text: stringField(word, "word") ?? "",
      startMs: secondsToMs(numberField(word, "start")),
      endMs: secondsToMs(numberField(word, "end")),
      confidence: clampConfidence(word.confidence), // a string in Flux's schema
    }));
    const transcript = stringField(message, "transcript")?.trim() ?? "";

    if (message.event === "EndOfTurn") {
      const turn = numberField(message, "turn_index");
      if (turn !== undefined && turn === this.#lastEndedTurn) return;
      this.#lastEndedTurn = turn;
      const utterances = toUtterances(words, {
        toSessionMs: (ms) => this.toSessionMs(ms),
        text: transcript,
        startMs: secondsToMs(numberField(message, "audio_window_start")),
        endMs: secondsToMs(numberField(message, "audio_window_end")),
        ...(this.createId ? { createId: this.createId } : {}),
      });
      for (const utterance of utterances) this.emit({ type: "final", utterance });
      this.emit({ type: "end_of_turn" });
      return;
    }

    // StartOfTurn, Update, EagerEndOfTurn, and TurnResumed all carry the turn so far.
    const text =
      transcript !== ""
        ? transcript
        : words
            .map((word) => word.text)
            .join(" ")
            .trim();
    if (text === "") return;
    const startMs = words[0]?.startMs ?? secondsToMs(numberField(message, "audio_window_start"));
    const endMs = words.at(-1)?.endMs ?? secondsToMs(numberField(message, "audio_window_end"));
    this.emit({
      type: "partial",
      text,
      startMs: Math.round(this.toSessionMs(startMs)),
      endMs: Math.round(this.toSessionMs(endMs)),
    });
  }
}
