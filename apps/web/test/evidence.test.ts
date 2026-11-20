// Evidence clips in the web app (Phase 5 spec §4.7, WP9; ADR-0036): the device's setting and the
// capture screen's notice, every no-audio state's own line and when each shows, where a card puts
// the target's play button, the page's hub (purges at start and on coming back into view, cards'
// clips read again after each change, a play readied in the gesture, "Playing what you said." said
// once, and a press whose clip has gone saying why), sign-out clearing the store, and that none of
// it can send audio anywhere.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Evidence, TARGET_FIELD } from "@earshot/core";
import {
  CLIP_TTL_MS,
  type Clip,
  type ClipMeta,
  ClipStore,
  memoryClipBackend,
} from "@earshot/voice/evidence";
import { describe, expect, it, vi } from "vitest";
import { QUESTION, UPDATE } from "@/components/inbox/fixtures";
import { signOutClearingClips } from "@/lib/evidence/browser";
import { CLIPS_COPY, NO_AUDIO_COPY, PLAYING_COPY, playLabel } from "@/lib/evidence/copy";
import { EvidenceHub, type HubPlayer, type VisibilityTarget } from "@/lib/evidence/hub";
import {
  CLIPS_OWNER_KEY,
  claimClips,
  clipsOwner,
  forgetClipsOwner,
  mayKeepClips,
} from "@/lib/evidence/owner";
import {
  browserStorage,
  CLIPS_NOTICE_KEY,
  CLIPS_SETTING_EVENT,
  CLIPS_SETTING_KEY,
  clipsNoticeDue,
  forgetUnsavedClipsSetting,
  markClipsNoticeSeen,
  readClipsSetting,
  writeClipsSetting,
} from "@/lib/evidence/setting";
import {
  cardEvidence,
  type EvidenceInputs,
  type EvidenceSession,
  sessionClipsExpired,
  spanState,
  targetWords,
  wouldHaveExpired,
} from "@/lib/evidence/state";
import type { InboxProposal } from "@/lib/inbox/types";

const SESSION_ID = "01a1c6e2-0000-7000-8000-0000000a0091";
const TURN = "01a1c6e2-0000-7000-8000-0000000d0091";
const STARTED = Date.parse("2026-11-20T14:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}

const throwing = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

describe("the device's setting and the capture screen's notice", () => {
  it("is on unless this device turned clips off", () => {
    expect(readClipsSetting(memoryStorage())).toBe("on");
    expect(readClipsSetting(memoryStorage({ [CLIPS_SETTING_KEY]: "off" }))).toBe("off");
    expect(readClipsSetting(memoryStorage({ [CLIPS_SETTING_KEY]: "on" }))).toBe("on");
    expect(readClipsSetting(null)).toBe("on");
    expect(readClipsSetting(throwing)).toBe("on");
  });

  it("records a change and tells this tab", () => {
    const storage = memoryStorage();
    const events = new EventTarget();
    const heard: string[] = [];
    events.addEventListener(CLIPS_SETTING_EVENT, (event) => heard.push(event.type));
    writeClipsSetting("off", { storage, events });
    expect(readClipsSetting(storage)).toBe("off");
    expect(heard).toEqual([CLIPS_SETTING_EVENT]);
    expect(() => writeClipsSetting("on", { storage: throwing, events })).not.toThrow();
  });

  it("owes the notice once: until it's seen, and never where storage can't remember it", () => {
    const storage = memoryStorage();
    expect(clipsNoticeDue(storage)).toBe(true);
    markClipsNoticeSeen(storage, new Date("2026-11-20T15:00:00.000Z"));
    expect(storage.values.get(CLIPS_NOTICE_KEY)).toBe("2026-11-20T15:00:00.000Z");
    expect(clipsNoticeDue(storage)).toBe(false);
    expect(clipsNoticeDue(throwing)).toBe(false);
    expect(clipsNoticeDue(null)).toBe(false);
  });

  it("says the spec's sentence, and that turning clips off deletes them", () => {
    expect(CLIPS_COPY.name).toBe("Evidence clips");
    expect(CLIPS_COPY.line).toBe(
      "Keeps what you say on this device for 24 hours so you can replay it while reviewing. Never uploaded.",
    );
    expect(CLIPS_COPY.offDeletes).toContain("deletes the ones already on this device");
  });
});

/** A clip of the session's first turn: 2 s to 6 s on its clock. */
function meta(overrides: Partial<ClipMeta> = {}): ClipMeta {
  return {
    id: `${SESSION_ID}:${TURN}`,
    sessionId: SESSION_ID,
    turnId: TURN,
    startMs: 2_000,
    durationMs: 4_000,
    createdAt: STARTED + 10_000,
    expiresAt: STARTED + 10_000 + CLIP_TTL_MS,
    samples: 64_000,
    ...overrides,
  };
}

function inputs(overrides: Partial<EvidenceInputs> = {}): EvidenceInputs {
  return {
    setting: "on",
    index: { status: "ready", clips: [meta()] },
    session: {
      sessionId: SESSION_ID,
      startedAt: new Date(STARTED).toISOString(),
      endedAt: new Date(STARTED + 120_000).toISOString(),
      recordedHere: false,
    },
    now: STARTED + HOUR,
    ...overrides,
  };
}

/** Evidence for words said at `audioMs` on the session's clock. */
function said(audioMs: [number, number]): Evidence {
  return {
    utteranceId: "01a1c6e2-0000-7000-8000-00000000c091",
    span: [0, 4],
    audioMs,
    confidence: 0.92,
  };
}

/** A proposal whose target and fields were said 3 to 5 s into the session. */
const PROPOSAL: Pick<InboxProposal, "proposalId" | "target" | "fields"> = {
  proposalId: "01a1c6e2-0000-7000-8000-0000000b0091",
  target: {
    ...UPDATE.target,
    mention: { quote: "the Acme platform deal", evidence: said([3_000, 3_600]) },
  },
  fields: {
    stage: { value: "proposal", evidence: said([4_000, 4_400]) },
    amount: { value: 40_000, evidence: said([4_500, 5_100]) },
  },
};

describe("each no-audio state, its trigger, and its own line", () => {
  it("has the spec's copy, word for word", () => {
    expect(NO_AUDIO_COPY).toEqual({
      clips_off: "Evidence clips are off. Turn them on in Settings → Capture.",
      another_device: "No audio on this device. It stays where you recorded it.",
      expired: "The audio was deleted after 24 hours.",
      unavailable: "This browser can't keep audio.",
      too_long: "That turn was too long to keep.",
    });
    expect(playLabel(1)).toBe("Play what you said, 1 second");
    expect(playLabel(2)).toBe("Play what you said, 2 seconds");
    expect(PLAYING_COPY).toBe("Playing what you said.");
  });

  it("plays a span a clip covers, named by its padded length", () => {
    const state = spanState(inputs(), [3_000, 3_600]);
    expect(state).toMatchObject({ kind: "playable", seconds: 1 });
    // 4,500 to 5,100 ms, padded: 4,250 to 5,350 ms, 1.1 s.
    expect(spanState(inputs(), [4_500, 5_100])).toMatchObject({ kind: "playable", seconds: 1 });
    // A long span: 2,100 to 5,900 ms, padded and clamped to the clip's 2,000 to 6,000: 4 s.
    expect(spanState(inputs(), [2_100, 5_900])).toMatchObject({ kind: "playable", seconds: 4 });
  });

  it("clips off: this device turned them off", () => {
    expect(spanState(inputs({ setting: "off" }), [3_000, 3_600])).toEqual({ kind: "clips_off" });
  });

  it("storage unavailable: the store won't open (no IndexedDB, as in iOS Lockdown Mode), even with clips off", () => {
    expect(spanState(inputs({ index: { status: "unavailable" } }), [3_000, 3_600])).toEqual({
      kind: "unavailable",
    });
    expect(
      spanState(inputs({ index: { status: "unavailable" }, setting: "off" }), [3_000, 3_600]),
    ).toEqual({ kind: "unavailable" });
  });

  it("older than 24 hours: the clip covering it expired, kept or purged", () => {
    // Kept, but past its 24 hours: never played.
    const expiresAt = meta().expiresAt;
    expect(spanState(inputs({ now: expiresAt }), [3_000, 3_600])).toEqual({ kind: "expired" });
    expect(spanState(inputs({ now: expiresAt - 1 }), [3_000, 3_600]).kind).toBe("playable");
    // Purged: no clip, and one of these words would have expired by now.
    const purged = inputs({ index: { status: "ready", clips: [] }, now: STARTED + 25 * HOUR });
    expect(spanState(purged, [3_000, 3_600])).toEqual({ kind: "expired" });
    expect(wouldHaveExpired(purged.session, [3_000, 3_600], STARTED + 3_600 + CLIP_TTL_MS)).toBe(
      true,
    );
    expect(wouldHaveExpired(purged.session, [3_000, 3_600], STARTED + 3_599 + CLIP_TTL_MS)).toBe(
      false,
    );
  });

  it("another device: no clip covers it, in a debrief this page didn't record", () => {
    const elsewhere = inputs({ index: { status: "ready", clips: [] } });
    expect(spanState(elsewhere, [3_000, 3_600])).toEqual({ kind: "another_device" });
    // Words outside every clip of the session.
    expect(spanState(inputs(), [9_000, 9_500])).toEqual({ kind: "another_device" });
  });

  it("too long: the turn ran past 120 s and kept no audio", () => {
    const tooLong = inputs({
      index: { status: "ready", clips: [meta({ durationMs: 125_000, samples: 0 })] },
    });
    expect(spanState(tooLong, [60_000, 61_000])).toEqual({ kind: "too_long" });
  });

  it("pending: still loading, or the capture screen's own turn isn't kept yet; nothing shows", () => {
    expect(spanState(inputs({ index: { status: "loading" } }), [3_000, 3_600])).toEqual({
      kind: "pending",
    });
    const here = inputs({ index: { status: "ready", clips: [] } });
    const live: EvidenceSession = { ...here.session, endedAt: null, recordedHere: true };
    expect(spanState({ ...here, session: live }, [3_000, 3_600])).toEqual({ kind: "pending" });
  });

  it("gives a card a button per span that plays, and one line for those that can't", () => {
    const evidence = cardEvidence(inputs(), PROPOSAL, true);
    expect(evidence.note).toBeNull();
    expect(evidence.target).toEqual({
      key: `${PROPOSAL.proposalId}:${TARGET_FIELD}`,
      sessionId: SESSION_ID,
      audioMs: [3_000, 3_600],
      seconds: 1,
    });
    expect(Object.keys(evidence.fields)).toEqual(["stage", "amount"]);
    expect(evidence.fields.stage?.key).toBe(`${PROPOSAL.proposalId}:stage`);
    // The target's words aren't shown: no button for them.
    expect(cardEvidence(inputs(), PROPOSAL, false).target).toBeNull();

    for (const [state, reason] of [
      [inputs({ setting: "off" }), "clips_off"],
      [inputs({ index: { status: "unavailable" } }), "unavailable"],
      [inputs({ index: { status: "ready", clips: [] } }), "another_device"],
      [inputs({ now: meta().expiresAt }), "expired"],
      [inputs({ index: { status: "ready", clips: [meta({ samples: 0 })] } }), "too_long"],
    ] as const) {
      expect(cardEvidence(state, PROPOSAL, true)).toEqual({
        target: null,
        fields: {},
        note: reason,
      });
    }
    expect(cardEvidence(inputs({ index: { status: "loading" } }), PROPOSAL, true)).toEqual({
      target: null,
      fields: {},
      note: null,
    });
  });

  it("doesn't read a session whose clips would all have expired", () => {
    const { session } = inputs();
    const ended = Date.parse(session.endedAt as string);
    expect(sessionClipsExpired(session, ended + CLIP_TTL_MS - 1)).toBe(false);
    expect(sessionClipsExpired(session, ended + CLIP_TTL_MS)).toBe(true);
    expect(sessionClipsExpired({ ...session, endedAt: null }, ended + 10 * CLIP_TTL_MS)).toBe(
      false,
    );
  });
});

describe("where a card puts the target's play button", () => {
  it("on the mention line, on a first-person line about the target, and nowhere else", () => {
    const line = (field: string | null) => ({
      reason: { tier: "loud" as const, kind: "ask" as const, field },
      lead: "",
      detail: null,
      text: "",
    });
    expect(targetWords({ mention: "Dana", firstPerson: null })).toBe("mention");
    expect(targetWords({ mention: "Dana", firstPerson: line(TARGET_FIELD) })).toBe("first_person");
    expect(targetWords({ mention: "Dana", firstPerson: line(null) })).toBe("first_person");
    expect(targetWords({ mention: "Dana", firstPerson: line("title") })).toBeNull();
    expect(targetWords({ mention: null, firstPerson: null })).toBeNull();
    expect(QUESTION.target.mention?.quote).toBe("Dana");
  });
});

/** A player that plays nothing, recording what it was asked. */
function fakePlayer() {
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const played: { key: string; clip: Clip; audioMs: readonly [number, number] }[] = [];
  let playing: string | null = null;
  const set = (key: string | null) => {
    playing = key;
    for (const listener of listeners) listener();
  };
  const player: HubPlayer = {
    get playing() {
      return playing;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    unlock: () => calls.push("unlock"),
    play: (key, clip, audioMs) => {
      calls.push("play");
      played.push({ key, clip, audioMs });
      set(key);
      return {};
    },
    stop: () => {
      calls.push("stop");
      set(null);
    },
  };
  return { player, calls, played, end: () => set(null) };
}

function fakePage(state: DocumentVisibilityState = "visible") {
  const target = new EventTarget();
  const page = {
    visibilityState: state,
    addEventListener: (type: "visibilitychange", listener: () => void) =>
      target.addEventListener(type, listener),
    removeEventListener: (type: "visibilitychange", listener: () => void) =>
      target.removeEventListener(type, listener),
    show: (next: DocumentVisibilityState) => {
      page.visibilityState = next;
      target.dispatchEvent(new Event("visibilitychange"));
    },
  };
  return page as VisibilityTarget & { show: (next: DocumentVisibilityState) => void };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function hubWithStore(options: { now?: () => number; open?: () => Promise<ClipStore> } = {}) {
  let now = STARTED + 10_000;
  const clock = options.now ?? (() => now);
  const store = await ClipStore.open({ backend: memoryClipBackend(), now: clock });
  const fake = fakePlayer();
  const timers = {
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  const hub = new EvidenceHub({
    openStore: options.open ?? (async () => store),
    player: fake.player,
    setting: () => "on",
    now: clock,
    timers,
  });
  return {
    hub,
    store,
    fake,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const SESSION: EvidenceSession = {
  sessionId: SESSION_ID,
  startedAt: new Date(STARTED).toISOString(),
  endedAt: null,
  recordedHere: true,
};

const SPAN = {
  key: "p:title",
  sessionId: SESSION_ID,
  audioMs: [3_000, 3_600] as const,
  seconds: 1,
};

describe("the page's evidence hub", () => {
  it("purges when Earshot starts and each time the page comes back into view, not as it hides", async () => {
    const { hub, store } = await hubWithStore();
    const purges: number[] = [];
    const purge = store.purge.bind(store);
    store.purge = async (now?: number) => {
      purges.push(now ?? 0);
      return purge(now);
    };
    const page = fakePage();
    const stop = hub.start(page);
    await settle();
    expect(purges).toHaveLength(1);
    page.show("hidden");
    await settle();
    expect(purges).toHaveLength(1);
    page.show("visible");
    await settle();
    expect(purges).toHaveLength(2);
    stop();
    page.show("hidden");
    page.show("visible");
    await settle();
    expect(purges).toHaveLength(2);
  });

  it("rereads the cards' clips when the page comes back into view, for what another tab kept", async () => {
    const backend = memoryClipBackend();
    const here = await ClipStore.open({ backend });
    const otherTab = await ClipStore.open({ backend });
    const hub = new EvidenceHub({
      openStore: async () => here,
      player: fakePlayer().player,
      setting: () => "on",
      now: () => STARTED + 10_000,
      timers: {
        setInterval: () => 0,
        clearInterval: () => {},
        setTimeout: () => 0,
        clearTimeout: () => {},
      },
    });
    const page = fakePage();
    hub.start(page);
    hub.watch(SESSION);
    await settle();
    expect(hub.index(SESSION_ID)).toEqual({ status: "ready", clips: [] });
    // Kept by another tab's store: this page's store says nothing of it.
    await otherTab.put({
      sessionId: SESSION_ID,
      turnId: TURN,
      audio: { startMs: 2_000, durationMs: 4_000, pcm: new Int16Array(64_000) },
    });
    await settle();
    expect(hub.index(SESSION_ID)).toEqual({ status: "ready", clips: [] });
    page.show("hidden");
    page.show("visible");
    await settle();
    await settle();
    const index = hub.index(SESSION_ID);
    expect(index.status === "ready" && index.clips).toHaveLength(1);
  });

  it("reads a watched session's clips, and again after each turn is kept", async () => {
    const { hub, store } = await hubWithStore();
    const stop = hub.watch(SESSION);
    expect(hub.index(SESSION_ID)).toEqual({ status: "loading" });
    await settle();
    expect(hub.index(SESSION_ID)).toEqual({ status: "ready", clips: [] });
    await store.put({
      sessionId: SESSION_ID,
      turnId: TURN,
      audio: { startMs: 2_000, durationMs: 4_000, pcm: new Int16Array(64_000) },
    });
    await settle();
    const index = hub.index(SESSION_ID);
    expect(index.status === "ready" && index.clips.map((clip) => clip.turnId)).toEqual([TURN]);
    stop();
  });

  it("readies Web Audio in the gesture, plays the clip's span, and says so once while it plays", async () => {
    const { hub, store, fake } = await hubWithStore();
    const pcm = new Int16Array(64_000).fill(7);
    await store.put({
      sessionId: SESSION_ID,
      turnId: TURN,
      audio: { startMs: 2_000, durationMs: 4_000, pcm },
    });
    hub.watch(SESSION);
    const playing = hub.play(SPAN);
    // Before anything awaited: the press itself readied the context.
    expect(fake.calls).toEqual(["unlock"]);
    expect(await playing).toBe("played");
    expect(fake.played).toHaveLength(1);
    expect(fake.played[0]?.audioMs).toEqual([3_000, 3_600]);
    expect(fake.played[0]?.clip.pcm).toEqual(pcm);
    expect(hub.playing()).toBe("p:title");
    expect(hub.announcement()).toBe("Playing what you said.");
    fake.end();
    expect(hub.announcement()).toBe("");
  });

  it("never plays a clip past its 24 hours, and says why in the card's words", async () => {
    const { hub, store, fake, advance } = await hubWithStore();
    await store.put({
      sessionId: SESSION_ID,
      turnId: TURN,
      audio: { startMs: 2_000, durationMs: 4_000, pcm: new Int16Array(64_000) },
    });
    hub.watch({ ...SESSION, recordedHere: false });
    await settle();
    advance(CLIP_TTL_MS);
    expect(await hub.play(SPAN)).toBe("missing");
    expect(fake.played).toEqual([]);
    expect(hub.announcement()).toBe("The audio was deleted after 24 hours.");
  });

  it("says another device's line when the clip is gone from a debrief recorded elsewhere", async () => {
    const { hub } = await hubWithStore();
    hub.watch({ ...SESSION, recordedHere: false });
    await settle();
    expect(await hub.play(SPAN)).toBe("missing");
    expect(hub.announcement()).toBe("No audio on this device. It stays where you recorded it.");
  });

  it("clears every clip and the key, and the cards read the store again", async () => {
    const { hub, store } = await hubWithStore();
    await store.put({
      sessionId: SESSION_ID,
      turnId: TURN,
      audio: { startMs: 2_000, durationMs: 4_000, pcm: new Int16Array(64_000) },
    });
    hub.watch(SESSION);
    await settle();
    await hub.clear();
    await settle();
    expect(hub.index(SESSION_ID)).toEqual({ status: "ready", clips: [] });
    expect(await store.list(SESSION_ID)).toEqual([]);
  });

  it("marks every card's audio unavailable where the store won't open, and plays nothing", async () => {
    const { hub, fake } = await hubWithStore({
      open: async () => {
        throw new Error("IndexedDB isn't available");
      },
    });
    hub.watch(SESSION);
    await settle();
    expect(hub.unavailable).toBe(true);
    expect(hub.index(SESSION_ID)).toEqual({ status: "unavailable" });
    expect(hub.index("another-session")).toEqual({ status: "unavailable" });
    expect(await hub.play(SPAN)).toBe("failed");
    expect(fake.played).toEqual([]);
    await expect(hub.clear()).resolves.toBeUndefined();
  });
});

describe("sign-out", () => {
  it("stops capture, clears the clips, forgets their owner, then signs out", async () => {
    const steps: string[] = [];
    await signOutClearingClips({
      stopCapture: () => steps.push("stop capture"),
      clearClips: async () => {
        steps.push("clear clips");
      },
      forgetOwner: () => steps.push("forget owner"),
      signOut: async () => {
        steps.push("sign out");
      },
    });
    expect(steps).toEqual(["stop capture", "clear clips", "forget owner", "sign out"]);
  });

  it("signs out even when clearing fails", async () => {
    const steps: string[] = [];
    await signOutClearingClips({
      stopCapture: () => steps.push("stop capture"),
      clearClips: async () => {
        throw new Error("IndexedDB is stuck");
      },
      forgetOwner: () => steps.push("forget owner"),
      signOut: async () => {
        steps.push("sign out");
      },
    });
    expect(steps).toEqual(["stop capture", "forget owner", "sign out"]);
  });

  it("leaves the store empty: no clip of any session, and no key", async () => {
    const backend = memoryClipBackend();
    const store = await ClipStore.open({ backend });
    for (const session of [SESSION_ID, "01a1c6e2-0000-7000-8000-0000000a0092"]) {
      await store.put({
        sessionId: session,
        turnId: TURN,
        audio: { startMs: 0, durationMs: 100, pcm: new Int16Array(1_600) },
      });
    }
    const hub = new EvidenceHub({
      openStore: async () => store,
      player: fakePlayer().player,
      setting: () => "on",
      now: () => Date.now(),
    });
    await signOutClearingClips({
      stopCapture: () => {},
      clearClips: () => hub.clear(),
      forgetOwner: () => {},
      signOut: async () => {},
    });
    expect(await store.list(SESSION_ID)).toEqual([]);
    expect(await store.list("01a1c6e2-0000-7000-8000-0000000a0092")).toEqual([]);
    expect(await backend.getDeviceKey()).toBeUndefined();
  });
});

// The automated security review of #62: the clips belong to one signed-in user, so the next user
// to sign in on this browser never inherits them, however the last session ended.
describe("whose clips these are", () => {
  function storage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    return {
      map,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
    };
  }
  const ALICE = "01a1c6e2-0000-7000-8000-00000000a11c";
  const BOB = "01a1c6e2-0000-7000-8000-000000000b0b";

  it("keeps the store when it's already this user's", async () => {
    const owned = storage({ [CLIPS_OWNER_KEY]: ALICE });
    const clear = vi.fn(async () => {});
    await expect(claimClips(ALICE, { storage: owned, clear })).resolves.toBe("kept");
    expect(clear).not.toHaveBeenCalled();
  });

  it("clears another user's clips before claiming the store, however their session ended", async () => {
    const owned = storage({ [CLIPS_OWNER_KEY]: ALICE });
    const clear = vi.fn(async () => {});
    await expect(claimClips(BOB, { storage: owned, clear })).resolves.toBe("cleared");
    expect(clear).toHaveBeenCalledOnce();
    expect(clipsOwner(owned)).toBe(BOB);
  });

  it("clears a store no one is recorded as owning", async () => {
    const empty = storage();
    const clear = vi.fn(async () => {});
    await expect(claimClips(ALICE, { storage: empty, clear })).resolves.toBe("cleared");
    expect(clear).toHaveBeenCalledOnce();
    expect(clipsOwner(empty)).toBe(ALICE);
  });

  it("keeps a clip only for the viewer who owns the store", () => {
    const owned = storage({ [CLIPS_OWNER_KEY]: ALICE });
    expect(mayKeepClips(ALICE, owned)).toBe(true);
    // A tab still running Alice's debrief after Bob signed in here, or after a sign-out elsewhere.
    expect(mayKeepClips(BOB, owned)).toBe(false);
    expect(mayKeepClips(ALICE, storage())).toBe(false);
    expect(mayKeepClips(null, owned)).toBe(false);
  });

  it("keeps nothing where storage is blocked, rather than guess", async () => {
    const blocked = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    const clear = vi.fn(async () => {});
    await expect(claimClips(ALICE, { storage: blocked, clear })).resolves.toBe("cleared");
    expect(mayKeepClips(ALICE, blocked)).toBe(false);
    expect(() => forgetClipsOwner(blocked)).not.toThrow();
  });

  it("forgets the owner at sign-out, which other tabs hear as a storage event", () => {
    const owned = storage({ [CLIPS_OWNER_KEY]: ALICE });
    forgetClipsOwner(owned);
    expect(clipsOwner(owned)).toBeNull();
    expect(mayKeepClips(ALICE, owned)).toBe(false);
  });
});

// Codex's review of #62: a refused write can't turn clips back on, a cleared or stopped hub plays
// nothing it was still reading, and blocked storage disables clips without breaking the page.
describe("the review's three fixes", () => {
  const refusing = {
    getItem: () => null,
    setItem: () => {
      throw new DOMException("full", "QuotaExceededError");
    },
  };
  const saying = (value: string | null) => ({ getItem: () => value, setItem: () => {} });

  it("keeps the rep's choice for the page when the browser won't save it", () => {
    try {
      writeClipsSetting("off", { storage: refusing });
      // Storage still says nothing (on), but this page turned clips off: off it stays.
      expect(readClipsSetting(saying(null))).toBe("off");
      expect(readClipsSetting(undefined)).toBe("off");
      // A choice the browser does save replaces it.
      writeClipsSetting("on", { storage: saying(null) });
      expect(readClipsSetting(saying(null))).toBe("on");
      // No storage at all, as when it's blocked: the choice holds for the page.
      writeClipsSetting("off", { storage: undefined });
      expect(readClipsSetting(undefined)).toBe("off");
    } finally {
      forgetUnsavedClipsSetting();
    }
  });

  it("reads blocked storage as no storage, never as a throw", () => {
    const blocked = {};
    Object.defineProperty(blocked, "localStorage", {
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    vi.stubGlobal("window", blocked);
    try {
      expect(browserStorage()).toBeUndefined();
      expect(readClipsSetting(browserStorage())).toBe("on");
      expect(clipsNoticeDue(browserStorage())).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("plays nothing a clear or a stop caught still reading its clip", async () => {
    for (const cancel of ["clear", "stop"] as const) {
      const { hub, store, fake } = await hubWithStore();
      await store.put({
        sessionId: SESSION_ID,
        turnId: TURN,
        audio: { startMs: 2_000, durationMs: 4_000, pcm: new Int16Array(64_000) },
      });
      const clip = await store.find(SESSION_ID, 3_300);
      expect(clip).not.toBeNull();
      // The press is still reading its clip from IndexedDB when the clear (or stop) comes.
      let deliver: (found: typeof clip) => void = () => {};
      store.find = () =>
        new Promise((resolve) => {
          deliver = resolve;
        });
      const played = hub.play(SPAN);
      await settle();
      if (cancel === "clear") await hub.clear();
      else hub.stop();
      deliver(clip);
      await expect(played).resolves.toBe("superseded");
      expect(fake.played).toHaveLength(0);
    }
  });
});

describe("clips never leave the device", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = ["lib/evidence", "components/evidence"].flatMap((dir) =>
    readdirSync(path.join(root, dir))
      .filter((file) => /\.tsx?$/.test(file))
      .map((file) => path.join(dir, file)),
  );
  const FORBIDDEN: readonly [string, RegExp][] = [
    ["fetch", /\bfetch\s*\(/],
    ["XMLHttpRequest", /\bXMLHttpRequest\b/],
    ["sendBeacon", /\bsendBeacon\b/],
    ["WebSocket", /\bWebSocket\b/],
    ["postMessage", /\bpostMessage\b/],
    ["BroadcastChannel", /\bBroadcastChannel\b/],
    ["console", /\bconsole\s*\./],
    ["a server action", /["']use server["']/],
  ];

  it("finds the evidence modules", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files) expect(statSync(path.join(root, file)).isFile()).toBe(true);
  });

  it.each(files)(
    "%s has no request, socket, cross-window message, server action, or log",
    (file) => {
      const source = readFileSync(path.join(root, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const [name, pattern] of FORBIDDEN) {
        expect(pattern.test(source), `${file} uses ${name}`).toBe(false);
      }
    },
  );

  it("adds no route: nothing under app/api speaks of clips or evidence", () => {
    const api = path.join(root, "app/api");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
      );
    const routes = walk(api);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(path.relative(api, route)).not.toMatch(/clip|evidence/i);
      expect(readFileSync(route, "utf8")).not.toMatch(/@earshot\/voice\/evidence|lib\/evidence/);
    }
  });
});
