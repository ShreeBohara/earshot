// What Earshot says about the recap (Phase 5 spec §4.9, WP10): the panel's words, one line for each
// reason there's no recap, and Settings → Capture's lens choice.
import type { RecapReason } from "@earshot/core";

export const RECAP_COPY = {
  title: "Recap",
  nextSteps: "Next steps",
  commitments: "Commitments",
  /** Before each quote, for screen readers, as the cards say it. */
  heard: "Heard:",
  /** On a sentence whose words say less than it does. */
  weakSupport: "Says more than these words do.",
  notMentioned: "Not mentioned",
  /** While the recap is being written, on the capture screen. */
  pending: "Writing the recap from what you said…",
  /** Every sentence quotes you: what the panel promises, once. */
  promise: "Every sentence quotes what you said. Open one to see the words.",
} as const;

/** "1 sentence left out" or "3 sentences left out", and why. */
export function droppedLine(dropped: number): string {
  return `${dropped} ${dropped === 1 ? "sentence was" : "sentences were"} left out: the words ${dropped === 1 ? "it quoted aren't" : "they quoted aren't"} in your transcript.`;
}

/** Why there's no recap, one line each. */
export const NO_RECAP_COPY: Readonly<Record<RecapReason, string>> = {
  no_key: "No recap: this debrief ended without an LLM key to write one.",
  no_speech: "No recap: nothing was said in this debrief.",
  invalid_output: "No recap: the model's answer didn't hold up, twice.",
  rate_limited: "No recap: the LLM provider was rate limiting your key.",
  provider_error: "No recap: the LLM provider failed or couldn't be reached.",
  timeout: "No recap: it didn't come back within 15 seconds.",
};

/** "MEDDIC: 2 of 6 mentioned", the lens's collapsed line. */
export function lensSummary(label: string, mentioned: number, fields: number): string {
  return `${label}: ${mentioned} of ${fields} mentioned`;
}

export const LENS_COPY = {
  name: "Recap lens",
  line: "Maps each debrief's recap to a sales methodology's fields, each with your own words or “not mentioned”. It sits collapsed under the recap, and it's chosen on this device only.",
  none: "None",
} as const;
