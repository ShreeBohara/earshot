// What Earshot says about evidence clips (Phase 5 spec §4.7, WP9): the setting, the capture screen's
// notice, the play button's name, and one line for each reason a card has no audio to play.

/** Why a card's words can't be played on this device: each has its own line (§4.7's table). */
export type NoAudioReason = "clips_off" | "another_device" | "expired" | "unavailable" | "too_long";

/** The spec's lines, word for word. The card links "Settings → Capture" in the first. */
export const NO_AUDIO_COPY: Readonly<Record<NoAudioReason, string>> = {
  clips_off: "Evidence clips are off. Turn them on in Settings → Capture.",
  another_device: "No audio on this device. It stays where you recorded it.",
  expired: "The audio was deleted after 24 hours.",
  unavailable: "This browser can't keep audio.",
  too_long: "That turn was too long to keep.",
};

export const CLIPS_COPY = {
  name: "Evidence clips",
  /** The spec's sentence, wherever the setting is offered. */
  line: "Keeps what you say on this device for 24 hours so you can replay it while reviewing. Never uploaded.",
  /** Turning clips off deletes what's kept: the safer of the two. */
  offDeletes: "Turning them off stops keeping clips and deletes the ones already on this device.",
  unavailable: "This browser can't keep audio, so clips stay off here.",
  notice: {
    title: "Evidence clips are on",
    dismiss: "Got it",
  },
} as const;

/** "1 second", "2 seconds". */
function seconds(n: number): string {
  return `${n} ${n === 1 ? "second" : "seconds"}`;
}

/** The play button's name: what it plays, and for how long. */
export function playLabel(spanSeconds: number): string {
  return `Play what you said, ${seconds(spanSeconds)}`;
}

/** Said once, politely, as a clip starts: never again while it plays. */
export const PLAYING_COPY = "Playing what you said.";
