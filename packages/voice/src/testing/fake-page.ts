// A page lifecycle a test drives by hand: go offline, come back, hide, show.
import type { PageEvent, PageLifecycle } from "../session/lifecycle";

export class FakePageLifecycle implements PageLifecycle {
  online: boolean;
  hidden: boolean;
  readonly suspendsWhenHidden: boolean;
  readonly #listeners = new Set<(event: PageEvent) => void>();

  constructor(options: { online?: boolean; hidden?: boolean; suspendsWhenHidden?: boolean } = {}) {
    this.online = options.online ?? true;
    this.hidden = options.hidden ?? false;
    this.suspendsWhenHidden = options.suspendsWhenHidden ?? false;
  }

  subscribe(listener: (event: PageEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Listeners attached now. */
  get listeners(): number {
    return this.#listeners.size;
  }

  /** Changes the page and tells every listener, as the browser's events would. */
  emit(event: PageEvent): void {
    if (event === "online" || event === "offline") this.online = event === "online";
    else this.hidden = event === "hidden";
    for (const listener of [...this.#listeners]) listener(event);
  }
}
