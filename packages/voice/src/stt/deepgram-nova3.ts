// Deepgram Nova-3 on /v1/listen (spec WP4 step 4).
//
// Wire format, from Deepgram's live audio reference (research note stt_providers.md §2–§5):
// - Connect: ${url}/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&interim_results=true,
//   where `url` is the token route's base (wss://api.deepgram.com), one `keyterm` per term, with
//   the subprotocols ["bearer", jwt].
// - Send: binary PCM16; {"type":"Configure","keyterms":[…]}; {"type":"Finalize"};
//   {"type":"KeepAlive"}; {"type":"CloseStream"}.
// - Receive: Results (is_final, speech_final, from_finalize, and channel.alternatives[0] with
//   transcript and words: word, punctuated_word, start, end, confidence, times in seconds);
//   UtteranceEnd; Metadata (duration, the audio seconds) after CloseStream; ConfigureSuccess or
//   ConfigureFailure.
//
// Segments marked is_final no longer change, but an utterance runs until speech_final (an
// endpoint), a Finalize answer (from_finalize), or UtteranceEnd. The adapter collects is_final
// segments and emits them as one utterance at that point, so a quote that spans segments still
// lands in one utterance. A Finalize answer and UtteranceEnd also end the turn.
import { TARGET_SAMPLE_RATE } from "../capture/dsp";
import type { SttAdapter, SttConnection, SttConnectOptions, SttLimits } from "./adapter";
import { type ConnectionSettings, numberField, recordsField, stringField } from "./connection";
import { providerSocketUrl } from "./credential";
import { appendKeyterms, DeepgramConnection, deepgramProtocols, secondsToMs } from "./deepgram";
import { DEEPGRAM_KEYTERM_LIMITS } from "./keyterms";
import { clampConfidence, type ProviderWord, toUtterances } from "./normalize";
import { type Clock, createBrowserSocket, type SocketFactory, systemClock } from "./socket";

export const DEEPGRAM_NOVA3_PATH = "/v1/listen";
export const DEEPGRAM_NOVA3_MODEL = "nova-3";

export interface DeepgramNova3Options {
  readonly socket?: SocketFactory;
  readonly clock?: Clock;
  readonly createId?: () => string;
  readonly model?: string;
  /** Silence that ends an utterance with speech_final, in ms (Deepgram's default is 10). */
  readonly endpointingMs?: number;
  /** A gap between words that sends UtteranceEnd, the hands-free end of turn (at least 1000). */
  readonly utteranceEndMs?: number;
  /** Numbers, dates, and punctuation formatted. Included in the price. */
  readonly smartFormat?: boolean;
  /** Keeps keyterms out of Deepgram's usage records. Off until WP1 confirms it. */
  readonly redactUsage?: boolean;
  /** Extra query parameters. */
  readonly params?: Readonly<Record<string, string>>;
  readonly openTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
}

export function createDeepgramNova3Adapter(options: DeepgramNova3Options = {}): SttAdapter {
  const settings: ConnectionSettings = {
    socket: options.socket ?? createBrowserSocket,
    clock: options.clock ?? systemClock,
    ...(options.createId ? { createId: options.createId } : {}),
    openTimeoutMs: options.openTimeoutMs ?? 10_000,
    closeTimeoutMs: options.closeTimeoutMs ?? 2_000,
  };
  const limits: SttLimits = { ...DEEPGRAM_KEYTERM_LIMITS, chunkMs: 64 };
  const model = options.model ?? DEEPGRAM_NOVA3_MODEL;
  return {
    id: "deepgram-nova3",
    provider: "deepgram",
    model,
    limits,
    async connect(opts: SttConnectOptions): Promise<SttConnection> {
      const connection = new Nova3Connection(settings, opts, options, model);
      await connection.opened(opts.signal);
      return connection;
    },
  };
}

/** The connect URL. The JWT travels as a subprotocol, not in it. */
export function deepgramNova3Url(opts: SttConnectOptions, options: DeepgramNova3Options): string {
  const url = providerSocketUrl(opts.credential, "deepgram", DEEPGRAM_NOVA3_PATH);
  const params = url.searchParams;
  params.set("model", options.model ?? DEEPGRAM_NOVA3_MODEL);
  params.set("encoding", "linear16");
  params.set("sample_rate", String(TARGET_SAMPLE_RATE));
  params.set("channels", "1");
  params.set("interim_results", "true");
  params.set("smart_format", String(options.smartFormat ?? true));
  params.set("endpointing", String(options.endpointingMs ?? 500));
  params.set("utterance_end_ms", String(options.utteranceEndMs ?? 1_300));
  if (options.redactUsage) params.set("redact_usage", "true");
  appendKeyterms(params, opts.keyterms);
  for (const [key, value] of Object.entries(options.params ?? {})) params.set(key, value);
  return url.toString();
}

class Nova3Connection extends DeepgramConnection {
  /** is_final segments not yet emitted, and their transcripts. */
  #words: ProviderWord[] = [];
  #texts: string[] = [];

  constructor(
    settings: ConnectionSettings,
    opts: SttConnectOptions,
    options: DeepgramNova3Options,
    model: string,
  ) {
    super(settings, {
      url: deepgramNova3Url(opts, options),
      protocols: deepgramProtocols(opts.credential.credential),
      provider: "deepgram",
      model,
      baseOffsetMs: opts.baseOffsetMs,
    });
  }

  finalize(): void {
    this.sendJson({ type: "Finalize" });
  }

  keepAlive(): void {
    this.sendJson({ type: "KeepAlive" });
  }

  protected handleMessage(message: Record<string, unknown>): void {
    if (this.handleConfigureReply(message) || this.handleErrorMessage(message)) return;
    switch (message.type) {
      case "Results":
        this.#onResults(message);
        return;
      case "UtteranceEnd":
        this.#emitUtterance();
        this.emit({ type: "end_of_turn" });
        return;
      case "Metadata": {
        const duration = numberField(message, "duration");
        if (duration !== undefined) this.reportUsage({ audioMs: duration * 1000 });
        return;
      }
      default:
        return; // SpeechStarted, and anything new
    }
  }

  #onResults(message: Record<string, unknown>): void {
    const channel = message.channel;
    const alternative =
      typeof channel === "object" && channel !== null
        ? recordsField(channel as Record<string, unknown>, "alternatives")[0]
        : undefined;
    const words: ProviderWord[] = alternative
      ? recordsField(alternative, "words").map((word) => ({
          text: stringField(word, "punctuated_word") ?? stringField(word, "word") ?? "",
          startMs: secondsToMs(numberField(word, "start")),
          endMs: secondsToMs(numberField(word, "end")),
          confidence: clampConfidence(word.confidence),
        }))
      : [];
    const transcript =
      (alternative ? stringField(alternative, "transcript") : undefined)?.trim() ?? "";

    if (message.is_final === true) {
      if (transcript !== "" || words.length > 0) {
        this.#words.push(...words);
        if (transcript !== "") this.#texts.push(transcript);
      }
      if (message.speech_final === true || message.from_finalize === true) this.#emitUtterance();
      else this.#emitPartial([], "");
      if (message.from_finalize === true) this.emit({ type: "end_of_turn" });
      return;
    }
    this.#emitPartial(words, transcript);
  }

  /** The committed segments plus the current interim one. */
  #emitPartial(interim: readonly ProviderWord[], interimText: string): void {
    const text = [...this.#texts, interimText].join(" ").trim();
    if (text === "") return;
    const first = this.#words[0] ?? interim[0];
    const last = interim.at(-1) ?? this.#words.at(-1);
    this.emit({
      type: "partial",
      text,
      startMs: Math.round(this.toSessionMs(first?.startMs ?? 0)),
      endMs: Math.round(this.toSessionMs(last?.endMs ?? first?.startMs ?? 0)),
    });
  }

  #emitUtterance(): void {
    if (this.#words.length === 0 && this.#texts.length === 0) return;
    const utterances = toUtterances(this.#words, {
      toSessionMs: (ms) => this.toSessionMs(ms),
      text: this.#texts.join(" "),
      ...(this.createId ? { createId: this.createId } : {}),
    });
    this.#words = [];
    this.#texts = [];
    for (const utterance of utterances) this.emit({ type: "final", utterance });
  }
}
