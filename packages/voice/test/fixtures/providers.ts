// Provider messages, written from each provider's documented message shapes as the Phase 3
// research note records them (research_notes/Earshot Phase 3 tooling check/stt_providers.md §3–§5).
// No provider was called to make them. WP1 replaces any field that turns out different.

// AssemblyAI v3: Begin, Turn (words carry text, start, end, confidence, word_is_final; times in
// ms from the stream's start), and Termination.
export const assemblyAi = {
  begin: { type: "Begin", id: "5d1c8f0e-1a2b-4c3d-9e8f-0a1b2c3d4e5f", expires_at: 1_794_000_000 },
  partial: {
    type: "Turn",
    turn_order: 0,
    turn_is_formatted: false,
    end_of_turn: false,
    transcript: "acme",
    end_of_turn_confidence: 0.06,
    words: [
      { start: 1_440, end: 1_680, text: "acme", confidence: 0.91, word_is_final: true },
      { start: 1_760, end: 1_920, text: "renew", confidence: 0.55, word_is_final: false },
    ],
  },
  endOfTurn: {
    type: "Turn",
    turn_order: 0,
    turn_is_formatted: false,
    end_of_turn: true,
    transcript: "acme renewed for two years",
    end_of_turn_confidence: 0.83,
    utterance: "acme renewed for two years",
    words: [
      { start: 1_440, end: 1_680, text: "acme", confidence: 0.91, word_is_final: true },
      { start: 1_760, end: 2_160, text: "renewed", confidence: 0.87, word_is_final: true },
      { start: 2_240, end: 2_400, text: "for", confidence: 0.99, word_is_final: true },
      { start: 2_480, end: 2_640, text: "two", confidence: 0.95, word_is_final: true },
      { start: 2_720, end: 3_040, text: "years", confidence: 0.93, word_is_final: true },
    ],
  },
  formattedEndOfTurn: {
    type: "Turn",
    turn_order: 0,
    turn_is_formatted: true,
    end_of_turn: true,
    transcript: "Acme renewed for two years.",
    end_of_turn_confidence: 0.83,
    words: [
      { start: 1_440, end: 1_680, text: "Acme", confidence: 0.91, word_is_final: true },
      { start: 1_760, end: 2_160, text: "renewed", confidence: 0.87, word_is_final: true },
      { start: 2_240, end: 2_400, text: "for", confidence: 0.99, word_is_final: true },
      { start: 2_480, end: 2_640, text: "two", confidence: 0.95, word_is_final: true },
      { start: 2_720, end: 3_040, text: "years.", confidence: 0.93, word_is_final: true },
    ],
  },
  termination: {
    type: "Termination",
    audio_duration_seconds: 12.48,
    session_duration_seconds: 15.02,
  },
} as const;

/** One Deepgram /v1/listen Results message; times in seconds. */
export function nova3Results(
  words: readonly [
    word: string,
    punctuated: string,
    start: number,
    end: number,
    confidence: number,
  ][],
  flags: { is_final: boolean; speech_final?: boolean; from_finalize?: boolean },
) {
  const transcript = words.map(([, punctuated]) => punctuated).join(" ");
  return {
    type: "Results",
    channel_index: [0, 1],
    duration: 1.2,
    start: words[0]?.[2] ?? 0,
    is_final: flags.is_final,
    speech_final: flags.speech_final ?? false,
    from_finalize: flags.from_finalize ?? false,
    channel: {
      alternatives: [
        {
          transcript,
          confidence: 0.97,
          words: words.map(([word, punctuated, start, end, confidence]) => ({
            word,
            start,
            end,
            confidence,
            punctuated_word: punctuated,
          })),
        },
      ],
    },
    metadata: { request_id: "f7a1b2c3-0000-4000-8000-000000000001", model_uuid: "nova-3" },
  };
}

export const nova3 = {
  interim: nova3Results([["acme", "Acme", 0.08, 0.48, 0.71]], { is_final: false }),
  segment1: nova3Results(
    [
      ["acme", "Acme", 0.08, 0.48, 0.98],
      ["renewed", "renewed", 0.56, 0.96, 0.9],
    ],
    { is_final: true },
  ),
  interim2: nova3Results([["for", "for", 1.04, 1.2, 0.6]], { is_final: false }),
  segment2Endpoint: nova3Results(
    [
      ["for", "for", 1.04, 1.2, 0.99],
      ["two", "two", 1.28, 1.44, 0.97],
      ["years", "years.", 1.52, 1.92, 0.94],
    ],
    { is_final: true, speech_final: true },
  ),
  finalizeAnswer: nova3Results([["thanks", "Thanks.", 2.4, 2.8, 0.92]], {
    is_final: true,
    from_finalize: true,
  }),
  emptyFinalizeAnswer: nova3Results([], { is_final: true, from_finalize: true }),
  utteranceEnd: { type: "UtteranceEnd", channel: [0, 1], last_word_end: 1.92 },
  speechStarted: { type: "SpeechStarted", channel: [0], timestamp: 0.04 },
  metadata: {
    type: "Metadata",
    request_id: "f7a1b2c3-0000-4000-8000-000000000001",
    created: "2026-11-15T12:00:00.000Z",
    duration: 9.65,
    channels: 1,
  },
  configureSuccess: { type: "ConfigureSuccess" },
  configureFailure: {
    type: "ConfigureFailure",
    code: "CONFIGURE_KEYTERM_LIMIT_EXCEEDED",
    description: "The keyterms exceed the 500-token limit.",
  },
} as const;

/** One Deepgram Flux TurnInfo message. Flux types word confidence as a string. */
export function fluxTurnInfo(
  event: "StartOfTurn" | "Update" | "EagerEndOfTurn" | "TurnResumed" | "EndOfTurn",
  turnIndex: number,
  words: readonly [word: string, start: number, end: number, confidence: string][],
  extra: Record<string, unknown> = {},
) {
  return {
    type: "TurnInfo",
    request_id: "a1b2c3d4-0000-4000-8000-000000000002",
    sequence_id: 3,
    event,
    turn_index: turnIndex,
    audio_window_start: words[0]?.[1] ?? 0,
    audio_window_end: words.at(-1)?.[2] ?? 0,
    transcript: words.map(([word]) => word).join(" "),
    words: words.map(([word, start, end, confidence]) => ({ word, start, end, confidence })),
    end_of_turn_confidence: event === "EndOfTurn" ? 0.91 : 0.2,
    languages: ["en"],
    ...extra,
  };
}

export const flux = {
  connected: {
    type: "Connected",
    request_id: "a1b2c3d4-0000-4000-8000-000000000002",
    sequence_id: 0,
  },
  update: fluxTurnInfo("Update", 0, [
    ["Acme", 0.12, 0.44, "0.97"],
    ["renewed", 0.52, 0.96, "0.88"],
  ]),
  eager: fluxTurnInfo("EagerEndOfTurn", 0, [
    ["Acme", 0.12, 0.44, "0.97"],
    ["renewed", 0.52, 0.96, "0.88"],
  ]),
  endOfTurn: fluxTurnInfo(
    "EndOfTurn",
    0,
    [
      ["Acme", 0.12, 0.44, "0.97"],
      ["renewed", 0.52, 0.96, "0.88"],
      ["today.", 1.04, 1.4, "0.92"],
    ],
    { trigger: "manual" },
  ),
  configureSuccess: { type: "ConfigureSuccess", sequence_id: 7 },
  configureFailure: {
    type: "ConfigureFailure",
    code: "CONFIGURE_KEYTERM_LIMIT_EXCEEDED",
    description: "Too many keyterm tokens.",
  },
  error: { type: "Error", code: "INVALID_MESSAGE", description: "Unknown message type." },
} as const;
