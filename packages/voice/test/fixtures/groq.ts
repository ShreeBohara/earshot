// Groq transcription responses for the second witness, written from Groq's documented shapes
// (console.groq.com/docs/speech-to-text, read 2026-11-20). No byte came from Groq; the live check
// (spec WP9, with the user's approval) replaces any field that turns out different.
//
// - Segment fields are the docs' example segment's: id, seek, start, end, text, tokens,
//   temperature, avg_logprob, compression_ratio, no_speech_prob (times in seconds).
// - Word fields are the ones the docs name for `timestamp_granularities[]=word`: word, start, end.
//   No confidence is documented for words.
// - The top level is the OpenAI-compatible verbose JSON the endpoint mirrors (task, language,
//   duration, text, segments, words), plus Groq's `x_groq`. Groq's docs don't list it; whether
//   segments come back with word-only granularity at all is the live check's question 4.

/** The e2e's scripted mishearing, as Whisper would write it: d003's first turn, "Atmo Systems". */
export const groqVerbose = {
  task: "transcribe",
  language: "English",
  duration: 7.4,
  text: " Debrief from Atmo Systems.  Raj Patel says finance wants to restart the onboarding package.",
  segments: [
    {
      id: 0,
      seek: 0,
      start: 0.32,
      end: 2.1,
      text: " Debrief from Atmo Systems.",
      tokens: [50365, 1346, 6023, 490, 1711, 78, 27059, 13, 50455],
      temperature: 0,
      avg_logprob: -0.2231436, // exp(-0.2231436) = 0.8
      compression_ratio: 0.9310345,
      no_speech_prob: 0.0124,
    },
    {
      id: 1,
      seek: 0,
      start: 2.4,
      end: 6.9,
      text: " Raj Patel says finance wants to restart the onboarding package.",
      tokens: [50475, 21123, 4379, 338, 1619, 10719, 2738, 281, 21022, 264, 322, 12544, 7372, 13],
      temperature: 0,
      avg_logprob: -0.1053605, // exp(-0.1053605) = 0.9
      compression_ratio: 1.1694915,
      no_speech_prob: 0.0091,
    },
  ],
  words: [
    { word: "Debrief", start: 0.32, end: 0.78 },
    { word: "from", start: 0.84, end: 1.02 },
    { word: "Atmo", start: 1.1, end: 1.46 },
    { word: "Systems", start: 1.52, end: 2.1 },
    { word: "Raj", start: 2.4, end: 2.66 },
    { word: "Patel", start: 2.7, end: 3.08 },
    { word: "says", start: 3.14, end: 3.38 },
    { word: "finance", start: 3.44, end: 3.92 },
    { word: "wants", start: 3.98, end: 4.24 },
    { word: "to", start: 4.3, end: 4.38 },
    { word: "restart", start: 4.44, end: 4.9 },
    { word: "the", start: 4.96, end: 5.06 },
    { word: "onboarding", start: 5.12, end: 5.84 },
    { word: "package", start: 5.9, end: 6.9 },
  ],
  x_groq: { id: "req_01kafwitnessfixture0000000" },
} as const;

/** The same answer with word timestamps only: no segments, so no confidence to read. */
export const groqWordsOnly = {
  task: "transcribe",
  language: "English",
  duration: 7.4,
  text: groqVerbose.text,
  words: groqVerbose.words,
  x_groq: { id: "req_01kafwitnessfixture0000001" },
} as const;

/** A rate limit, as an OpenAI-compatible error body. */
export const groqRateLimited = {
  error: {
    message: "Rate limit reached for model `whisper-large-v3-turbo`: requests per minute.",
    type: "requests",
    code: "rate_limit_exceeded",
  },
} as const;
