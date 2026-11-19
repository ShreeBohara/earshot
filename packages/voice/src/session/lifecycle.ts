// The page's lifecycle, as SessionClient needs it: online or offline, visible or hidden, and
// whether a hidden page loses its microphone and sockets. Injected, so tests drive it by hand
// (`FakePageLifecycle` in `@earshot/voice/testing`).

export type PageEvent = "online" | "offline" | "hidden" | "visible";

export interface PageLifecycle {
  readonly online: boolean;
  readonly hidden: boolean;
  /**
   * True on iOS and iPadOS: there a hidden page loses the microphone (WebKit bug 226620) and is
   * soon frozen with its sockets, so the client stops capture, flushes, and closes cleanly first.
   */
  readonly suspendsWhenHidden: boolean;
  subscribe(listener: (event: PageEvent) => void): () => void;
}

/** True for iPhone, iPod, and iPad, including iPadOS, which reports itself as a Mac with touch. */
export function isIosPlatform(navigator: {
  readonly userAgent: string;
  readonly platform?: string;
  readonly maxTouchPoints?: number;
}): boolean {
  if (/\b(iPhone|iPad|iPod)\b/.test(navigator.userAgent)) return true;
  return navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1;
}

/** A page that's always online and visible: for Node, server rendering, and tests. */
export const STEADY_PAGE: PageLifecycle = Object.freeze({
  online: true,
  hidden: false,
  suspendsWhenHidden: false,
  subscribe: () => () => {},
});

/**
 * The browser's page: `online` and `offline` on window; `visibilitychange`, plus `pagehide` and
 * `pageshow`, which also cover the back-forward cache. Outside a browser, `STEADY_PAGE`.
 */
export function browserPageLifecycle(): PageLifecycle {
  const win = globalThis.window as Window | undefined;
  const doc = globalThis.document as Document | undefined;
  if (!win || !doc) return STEADY_PAGE;
  const nav = win.navigator;
  return {
    get online() {
      return nav.onLine !== false;
    },
    get hidden() {
      return doc.visibilityState === "hidden";
    },
    suspendsWhenHidden: isIosPlatform(nav),
    subscribe(listener) {
      const online = () => listener("online");
      const offline = () => listener("offline");
      const visibility = () => listener(doc.visibilityState === "hidden" ? "hidden" : "visible");
      const hide = () => listener("hidden");
      const show = () => listener(doc.visibilityState === "hidden" ? "hidden" : "visible");
      win.addEventListener("online", online);
      win.addEventListener("offline", offline);
      doc.addEventListener("visibilitychange", visibility);
      win.addEventListener("pagehide", hide);
      win.addEventListener("pageshow", show);
      return () => {
        win.removeEventListener("online", online);
        win.removeEventListener("offline", offline);
        doc.removeEventListener("visibilitychange", visibility);
        win.removeEventListener("pagehide", hide);
        win.removeEventListener("pageshow", show);
      };
    },
  };
}
