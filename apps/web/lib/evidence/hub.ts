// The page's evidence clips (Phase 5 spec WP9; ADR-0036): one clip store and one player for the
// whole signed-in app, framework-free so React reads it through `subscribe` and the tests drive it
// on a memory store and a fake player.
//
// - **Purges:** when Earshot starts (`start`), and each time the page comes back into view; the
//   store purges before each write itself, and sign-out clears everything (`clear`).
// - **What the cards read:** each watched session's clips, without their audio, read again after
//   anything is kept, purged, or cleared. A session whose clips would all be past their 24 hours
//   isn't read at all.
// - **Playing:** `play` must be called in the click or key handler that asked, since the player
//   readies Web Audio there before anything awaits; the clip is read from the store on each play,
//   so a clip deleted or expired since the card rendered never plays from memory.
// - **Saying it:** the page's status line reads "Playing what you said." once as a clip starts, and
//   goes quiet when it ends; it never counts along. A press whose clip has gone since the card
//   rendered says why instead, in the card's own words, as the card turns to say it too.
import type { Clip, ClipStore } from "@earshot/voice/evidence";
import { spanMiddle } from "@earshot/voice/evidence";
import { NO_AUDIO_COPY, PLAYING_COPY } from "./copy";
import type { ClipsSetting } from "./setting";
import {
  type ClipIndex,
  type EvidenceSession,
  type PlayableSpan,
  sessionClipsExpired,
  spanState,
} from "./state";

/** The player, as the hub uses it: `ClipPlayer` in the browser, a fake in tests. */
export interface HubPlayer {
  readonly playing: string | null;
  subscribe(listener: () => void): () => void;
  unlock(): void;
  play(key: string, clip: Clip, audioMs: readonly [number, number]): unknown;
  stop(): void;
}

/** What `document` offers for "the page came back into view". */
export interface VisibilityTarget {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface EvidenceHubDeps {
  /** Opens the clip store; rejects where this browser can't keep audio. */
  readonly openStore: () => Promise<ClipStore>;
  readonly player: HubPlayer;
  /** This device's choice (Settings → Capture), read when a press finds its clip gone. */
  readonly setting: () => ClipsSetting;
  /** Epoch ms. */
  readonly now: () => number;
  readonly timers?: {
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

/** How a press went. */
export type PlayOutcome = "played" | "missing" | "failed" | "superseded";

const LOADING: ClipIndex = { status: "loading" };
const UNAVAILABLE: ClipIndex = { status: "unavailable" };
const NONE: ClipIndex = { status: "ready", clips: [] };

/** How often the cards' clock moves, so a clip's 24 hours run out on screen too. */
const TICK_MS = 60_000;

/** How long a "why there's no audio" message stays in the status line. */
const MESSAGE_MS = 10_000;

const BROWSER_TIMERS: NonNullable<EvidenceHubDeps["timers"]> = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class EvidenceHub {
  readonly #deps: EvidenceHubDeps;
  readonly #timers: NonNullable<EvidenceHubDeps["timers"]>;
  readonly #listeners = new Set<() => void>();
  readonly #indexes = new Map<string, ClipIndex>();
  readonly #watched = new Map<string, { session: EvidenceSession; count: number }>();
  #store: Promise<ClipStore> | null = null;
  #unavailable = false;
  #now: number;
  #plays = 0;
  #message = "";
  #messageTimer: unknown = null;
  #unsubscribeStore: (() => void) | null = null;

  constructor(deps: EvidenceHubDeps) {
    this.#deps = deps;
    this.#timers = deps.timers ?? BROWSER_TIMERS;
    this.#now = deps.now();
    deps.player.subscribe(() => this.#notify());
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The cards' clock: epoch ms, moved on once a minute while the app runs. */
  readonly now = (): number => this.#now;

  /** The key of the span playing now, or null. */
  readonly playing = (): string | null => this.#deps.player.playing;

  /** The page's status line: said as a clip starts, or why a press found no clip; else empty. */
  readonly announcement = (): string => (this.#deps.player.playing ? PLAYING_COPY : this.#message);

  /** Whether the store failed to open: this browser can't keep audio. */
  get unavailable(): boolean {
    return this.#unavailable;
  }

  /** The clip store, opened once; a failure to open is remembered as "can't keep audio". */
  store(): Promise<ClipStore> {
    if (!this.#store) {
      this.#store = this.#deps.openStore().then(
        (store) => {
          this.#unsubscribeStore = store.subscribe(() => void this.#reloadAll());
          return store;
        },
        (error: unknown) => {
          this.#unavailable = true;
          for (const sessionId of this.#indexes.keys()) this.#indexes.set(sessionId, UNAVAILABLE);
          this.#notify();
          throw error;
        },
      );
      this.#store.catch(() => {});
    }
    return this.#store;
  }

  /**
   * Earshot started: purge expired clips now and whenever the page comes back into view, and move
   * the cards' clock on each minute. Returns the cleanup.
   */
  start(page: VisibilityTarget): () => void {
    const purge = (reread: boolean) => {
      this.#tick();
      void this.store().then(
        async (store) => {
          // A purge that deletes anything rereads the cards' clips itself; coming back into view
          // rereads them anyway, since another tab may have kept or cleared clips meanwhile.
          if ((await store.purge()) === 0 && reread) await this.#reloadAll();
        },
        () => {},
      );
    };
    const onVisibility = () => {
      if (page.visibilityState === "visible") purge(true);
    };
    purge(false);
    page.addEventListener("visibilitychange", onVisibility);
    const ticking = this.#timers.setInterval(() => this.#tick(), TICK_MS);
    return () => {
      page.removeEventListener("visibilitychange", onVisibility);
      this.#timers.clearInterval(ticking);
    };
  }

  /** A card shows a session's words: read its clips, and again after each change. */
  watch(session: EvidenceSession): () => void {
    const entry = this.#watched.get(session.sessionId);
    if (entry) {
      entry.count += 1;
      entry.session = session;
    } else {
      this.#watched.set(session.sessionId, { session, count: 1 });
      void this.#load(session);
    }
    return () => {
      const current = this.#watched.get(session.sessionId);
      if (!current) return;
      current.count -= 1;
      if (current.count <= 0) this.#watched.delete(session.sessionId);
    };
  }

  /** A session's clips as last read: the same object until they change. */
  index(sessionId: string): ClipIndex {
    if (this.#unavailable) return UNAVAILABLE;
    return this.#indexes.get(sessionId) ?? LOADING;
  }

  /**
   * Plays a span of a card's words. Call it in the click or key handler: the player readies Web
   * Audio first, synchronously. Resolves to `missing` when the clip has gone since the card
   * rendered (expired, deleted, or unreadable), after the session's clips are read again so the
   * card can say why.
   */
  play(span: PlayableSpan): Promise<PlayOutcome> {
    this.#deps.player.unlock();
    this.#say("");
    const ticket = ++this.#plays;
    return (async (): Promise<PlayOutcome> => {
      let clip: Clip | null;
      try {
        clip = await (await this.store()).find(span.sessionId, spanMiddle(span.audioMs));
      } catch {
        return ticket === this.#plays ? "failed" : "superseded";
      }
      if (ticket !== this.#plays) return "superseded";
      if (!clip) {
        await this.#missing(span);
        return "missing";
      }
      return this.#deps.player.play(span.key, clip, span.audioMs) ? "played" : "failed";
    })();
  }

  /** A press found no clip: read the session's clips again, and say why in the card's words. */
  async #missing(span: PlayableSpan): Promise<void> {
    const watched = this.#watched.get(span.sessionId);
    if (!watched) return;
    await this.#load(watched.session);
    const state = spanState(
      {
        setting: this.#deps.setting(),
        index: this.index(span.sessionId),
        session: watched.session,
        now: this.#deps.now(),
      },
      span.audioMs,
    );
    if (state.kind !== "playable" && state.kind !== "pending") this.#say(NO_AUDIO_COPY[state.kind]);
  }

  /**
   * Stops the clip playing, if any, and any press still reading its clip: a play waiting on
   * IndexedDB or decryption finds its ticket gone and doesn't start.
   */
  stop(): void {
    this.#plays += 1;
    this.#deps.player.stop();
  }

  /**
   * Deletes every clip and the store's key: sign-out, or clips turned off. Resolves once the store
   * holds nothing, or at once where it never opened. A press still reading its clip is cancelled
   * first, so nothing read before the clear plays after it (Codex's review of #62).
   */
  async clear(): Promise<void> {
    this.stop();
    let store: ClipStore;
    try {
      store = await this.store();
    } catch {
      return;
    }
    await store.clear();
  }

  async #load(session: EvidenceSession): Promise<void> {
    const { sessionId } = session;
    if (sessionClipsExpired(session, this.#deps.now())) {
      this.#set(sessionId, NONE);
      return;
    }
    let store: ClipStore;
    try {
      store = await this.store();
    } catch {
      this.#set(sessionId, UNAVAILABLE);
      return;
    }
    try {
      const clips = await store.list(sessionId);
      this.#set(sessionId, { status: "ready", clips });
    } catch {
      this.#set(sessionId, UNAVAILABLE);
    }
  }

  async #reloadAll(): Promise<void> {
    await Promise.all([...this.#watched.values()].map((entry) => this.#load(entry.session)));
  }

  #set(sessionId: string, index: ClipIndex): void {
    // A session nobody watches any more needn't be kept.
    if (!this.#watched.has(sessionId)) {
      this.#indexes.delete(sessionId);
      return;
    }
    this.#indexes.set(sessionId, index);
    this.#notify();
  }

  #tick(): void {
    this.#now = this.#deps.now();
    this.#notify();
  }

  /** Puts `text` in the status line for a while; "" empties it. */
  #say(text: string): void {
    if (this.#messageTimer !== null) this.#timers.clearTimeout(this.#messageTimer);
    this.#messageTimer = null;
    if (text !== "") {
      this.#messageTimer = this.#timers.setTimeout(() => {
        this.#messageTimer = null;
        this.#say("");
      }, MESSAGE_MS);
    }
    if (this.#message === text) return;
    this.#message = text;
    this.#notify();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A subscriber's bug mustn't stop the others.
      }
    }
  }

  /** Lets the store go (tests). */
  dispose(): void {
    this.#unsubscribeStore?.();
    this.#unsubscribeStore = null;
  }
}
