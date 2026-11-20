// Sound the screen makes: the silent-response chime (WP8's machine decides when) and the optional
// spoken confirmations. Both wait until audio output is safe: on iOS, until the microphone track
// has stopped, because WebKit crackles sound played while an echo-cancelled mic is live.

/** A soft two-note chime, about 250 ms. Never throws: a page without audio stays quiet. */
export function playChime(): void {
  try {
    const AudioContextClass = globalThis.AudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const gain = context.createGain();
    gain.connect(context.destination);
    const start = context.currentTime;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.08, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.25);
    for (const [index, frequency] of [660, 880].entries()) {
      const tone = context.createOscillator();
      tone.type = "sine";
      tone.frequency.value = frequency;
      tone.connect(gain);
      tone.start(start + index * 0.08);
      tone.stop(start + 0.26);
    }
    setTimeout(() => void context.close().catch(() => {}), 500);
  } catch {
    // No audio output: the feed row says it anyway.
  }
}

/**
 * Optional spoken confirmations, off by default. Lines queue while the microphone is live and
 * play once it stops (the end of the debrief, or a pause). The on-screen text always shows.
 */
export class SpokenConfirmations {
  readonly #synth: SpeechSynthesis | undefined;
  readonly #queue: string[] = [];
  #enabled = false;

  constructor(synth: SpeechSynthesis | undefined) {
    this.#synth = synth;
  }

  get available(): boolean {
    return this.#synth !== undefined;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled && this.available;
    if (!this.#enabled) this.clear();
  }

  /** Queues a line. It plays at the next `flush` while output is safe. */
  say(line: string): void {
    if (this.#enabled) this.#queue.push(line);
  }

  /** Speaks every queued line, if `safe`. */
  flush(safe: boolean): void {
    if (!safe || !this.#enabled || !this.#synth) return;
    for (const line of this.#queue.splice(0)) {
      this.#synth.speak(new SpeechSynthesisUtterance(line));
    }
  }

  clear(): void {
    this.#queue.length = 0;
    this.#synth?.cancel();
  }
}
