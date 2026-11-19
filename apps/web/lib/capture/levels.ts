// The orb's levels: written by the voice engine about 30 times a second and read by the orb's
// own animation frame, never through React state, so a level never re-renders the screen.
import type { LevelSource, OrbLevels } from "@earshot/ui/components/orb";

const SILENT: OrbLevels = Object.freeze({ mic: 0, agent: 0 });

export class LevelMeter implements LevelSource {
  #levels: OrbLevels = SILENT;
  readonly #listeners = new Set<() => void>();

  readonly get = (): OrbLevels => this.#levels;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  set(mic: number, agent: number): void {
    if (mic === this.#levels.mic && agent === this.#levels.agent) return;
    this.#levels = { mic, agent };
    for (const listener of this.#listeners) listener();
  }

  reset(): void {
    this.set(0, 0);
  }
}
