import { describe, expect, it, vi } from "vitest";
import {
  type FlagStore,
  PERSIST_KEY,
  requestPersistenceOnce,
  showsHomeScreenHint,
} from "@/lib/keys/device-storage";

function flagStore(initial: Record<string, string> = {}): FlagStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

const NOW = () => new Date("2026-11-20T12:00:00.000Z");

describe("requestPersistenceOnce (spec WP3b)", () => {
  it("asks the browser once, and remembers the answer", async () => {
    const persist = vi.fn(async () => true);
    const flags = flagStore();
    await expect(requestPersistenceOnce({ persist }, flags, NOW)).resolves.toBe(true);
    await expect(requestPersistenceOnce({ persist }, flags, NOW)).resolves.toBeNull();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(JSON.parse(flags.map.get(PERSIST_KEY) ?? "null")).toEqual({
      at: "2026-11-20T12:00:00.000Z",
      granted: true,
    });
  });

  it("asks once when two saves race", async () => {
    let answer: (granted: boolean) => void = () => {};
    const persist = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const flags = flagStore();
    const first = requestPersistenceOnce({ persist }, flags, NOW);
    const second = requestPersistenceOnce({ persist }, flags, NOW);
    answer(false);
    await expect(Promise.all([first, second])).resolves.toEqual([false, null]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(JSON.parse(flags.map.get(PERSIST_KEY) ?? "null")).toMatchObject({ granted: false });
  });

  it("doesn't ask again on a later visit", async () => {
    const persist = vi.fn(async () => true);
    const flags = flagStore({ [PERSIST_KEY]: '{"at":"2026-11-01T09:00:00.000Z","granted":false}' });
    await expect(requestPersistenceOnce({ persist }, flags, NOW)).resolves.toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });

  it("counts a refusal by exception as no, and doesn't ask again", async () => {
    const persist = vi.fn(async (): Promise<boolean> => {
      throw new Error("refused");
    });
    const flags = flagStore();
    await expect(requestPersistenceOnce({ persist }, flags, NOW)).resolves.toBe(false);
    await expect(requestPersistenceOnce({ persist }, flags, NOW)).resolves.toBeNull();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("does nothing without the Storage API", async () => {
    const flags = flagStore();
    await expect(requestPersistenceOnce(undefined, flags, NOW)).resolves.toBeNull();
    await expect(requestPersistenceOnce({}, flags, NOW)).resolves.toBeNull();
    expect(flags.map.size).toBe(0);
  });

  it("doesn't ask when it can't remember asking, which would ask on every save", async () => {
    const persist = vi.fn(async () => true);
    await expect(requestPersistenceOnce({ persist }, undefined, NOW)).resolves.toBeNull();
    const refusing: FlagStore = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    };
    await expect(requestPersistenceOnce({ persist }, refusing, NOW)).resolves.toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });
});

// Real user agents, 2026. iPadOS's Safari asks for desktop sites, so it says "Macintosh".
const UA = {
  iPhoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  iPadSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  iPadMobileSite:
    "Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  iPhoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.101 Mobile/15E148 Safari/604.1",
  iPhoneFirefox:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15",
  iPhoneEdge:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/140.3485.94 Mobile/15E148 Safari/605.1.15",
  iPhoneInApp:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.0.0",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  desktopChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
};

describe("showsHomeScreenHint (spec WP3b)", () => {
  it.each([
    ["Safari on an iPhone", { userAgent: UA.iPhoneSafari, maxTouchPoints: 5, standalone: false }],
    ["Safari on an iPad", { userAgent: UA.iPadSafari, maxTouchPoints: 5, standalone: false }],
    [
      "Safari on an iPad, asking for the mobile site",
      { userAgent: UA.iPadMobileSite, maxTouchPoints: 5, standalone: false },
    ],
  ])("shows on %s outside a Home Screen app", (_, nav) => {
    expect(showsHomeScreenHint(nav)).toBe(true);
  });

  it.each([
    [
      "a Home Screen app on an iPhone",
      { userAgent: UA.iPhoneSafari, maxTouchPoints: 5, standalone: true },
    ],
    [
      "a Home Screen app on an iPad",
      { userAgent: UA.iPadSafari, maxTouchPoints: 5, standalone: true },
    ],
    ["Safari on a Mac", { userAgent: UA.macSafari, maxTouchPoints: 0 }],
    ["Chrome on an iPhone", { userAgent: UA.iPhoneChrome, maxTouchPoints: 5, standalone: false }],
    ["Firefox on an iPhone", { userAgent: UA.iPhoneFirefox, maxTouchPoints: 5, standalone: false }],
    ["Edge on an iPhone", { userAgent: UA.iPhoneEdge, maxTouchPoints: 5, standalone: false }],
    ["an in-app browser", { userAgent: UA.iPhoneInApp, maxTouchPoints: 5, standalone: false }],
    ["Chrome on Android", { userAgent: UA.androidChrome, maxTouchPoints: 5 }],
    ["Chrome on a desktop", { userAgent: UA.desktopChrome, maxTouchPoints: 0 }],
  ])("doesn't show in %s", (_, nav) => {
    expect(showsHomeScreenHint(nav)).toBe(false);
  });
});
