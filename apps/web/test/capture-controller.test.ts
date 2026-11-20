// The capture controller end to end on WP8's fakes: an in-memory SessionDO, the fake adapter, a
// scripted capture source, and a manual clock. No browser, no network, no provider.
import type { StoredKeyMeta } from "@earshot/keys";
import { createDebriefEngine, type SttAdapter, type WitnessRunner } from "@earshot/voice";
import { createSessionClient } from "@earshot/voice/session";
import {
  createFakeSttAdapter,
  createFakeWitness,
  FakeCaptureSource,
  FakePageLifecycle,
  FakeSessionServer,
  fakeCredential,
  NO_TARGET,
  settle,
} from "@earshot/voice/testing";
import { describe, expect, it } from "vitest";
import { SpokenConfirmations } from "@/lib/capture/audio-out";
import { CaptureController, type CaptureDeps } from "@/lib/capture/controller";
import { createFakeVoice } from "@/lib/capture/dev/fake-voice";
import type { FakeScenario } from "@/lib/capture/fake";
import type { WitnessSetting } from "@/lib/capture/witness";
import { decisionReview, undoReview } from "@/lib/inbox/review";
import { socketSink } from "@/lib/inbox/sinks";
import { ManualClock } from "./support/manual-clock";

const SESSION_ID = "0000000a-0000-7000-8000-0000000ca901";

const SCENARIO: FakeScenario = {
  version: 1,
  name: "test",
  startedAt: "2026-11-10T19:15:00.000Z",
  timeZone: "America/Los_Angeles",
  entities: [{ id: "co_1", kind: "company", name: "Acme Corp", aliases: ["Acme"] }],
  focusEntityId: "co_1",
  llm: { provider: "anthropic", model: "claude-haiku-5-5" },
  turns: [{ text: "Met Dana Lee at Acme Corp" }, { text: "That is all" }],
};

/** For runs with a third engine, which says a third line. */
const THREE_LINES: FakeScenario = {
  ...SCENARIO,
  turns: [...SCENARIO.turns, { text: "Dana Lee wants the pricing deck by Friday" }],
};

function setup(
  options: {
    keys?: StoredKeyMeta[];
    revealed?: string;
    sessionStatus?: number;
    /** Hold the microphone prompt open until `grantMicrophone()`. */
    holdMicrophone?: boolean;
    /** For real mode: the speech-to-text adapter the picked option gets. */
    adapter?: () => SttAdapter;
    /** The device's second-witness answer; absent, the app wires no witness. */
    witnessSetting?: WitnessSetting | null;
    createWitness?: (key: () => Promise<string | undefined>) => WitnessRunner;
  } = {},
) {
  const clock = new ManualClock();
  const server = new FakeSessionServer({
    sessionId: SESSION_ID,
    propose: (turn) =>
      turn.utterances
        .filter((u) => u.text.includes("Dana"))
        .map((u) => ({
          type: "contact" as const,
          target: { ...NO_TARGET, decision: "new" as const, kind: "contact" as const, p: 1 },
          fields: {
            name: {
              value: "Dana Lee",
              evidence: {
                utteranceId: u.utteranceId,
                span: [4, 12] as [number, number],
                audioMs: [u.startMs, u.endMs] as [number, number],
                confidence: u.confidence,
              },
            },
          },
          riskFlags: [{ kind: "new_entity" as const, field: "target" }],
        })),
  });
  /** One per engine, as each engine starts its own capture graph and closes it when it stops. */
  const captures: FakeCaptureSource[] = [];
  const routes: { url: string; body: unknown }[] = [];
  const ticket = () => server.issueTicket();
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    routes.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/sessions") {
      if (options.sessionStatus) {
        return Response.json(
          { error: "too_many_requests", message: "Slow down.", retryAfterSeconds: 120 },
          { status: options.sessionStatus },
        );
      }
      const first = ticket();
      return Response.json(
        {
          sessionId: SESSION_ID,
          ticket: first.ticket,
          ticketExpiresAt: first.ticketExpiresAt,
          edgeUrl: server.edgeUrl,
          entities: [{ id: "crm-1", kind: "company", name: "Real CRM Co", aliases: [] }],
          focusEntityId: "crm-1",
          keyterms: { assemblyai: ["Real CRM Co"], deepgram: ["Real CRM Co"] },
        },
        { status: 201 },
      );
    }
    if (url.endsWith("/ticket")) {
      const next = ticket();
      return Response.json(next);
    }
    if (url === `/api/sessions/${SESSION_ID}/reviews`) {
      // The web route, once the session is sealed: it writes what it's sent.
      const body = JSON.parse(String(init?.body)) as {
        reviews: { reviewId: string }[];
        snoozes: { snoozeId: string }[];
      };
      return Response.json({
        sessionId: SESSION_ID,
        reviews: body.reviews.map((review, index) => ({
          id: review.reviewId,
          seq: 100 + index,
          recorded: "now",
        })),
        snoozes: body.snoozes.map((snooze, index) => ({
          id: snooze.snoozeId,
          seq: 200 + index,
          recorded: "now",
        })),
        lastSeq: 300,
      });
    }
    if (url === "/api/voice/token") return Response.json(fakeCredential("assemblyai"));
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;

  let micOpen = false;
  let grant: (() => void) | undefined;
  const chimes: number[] = [];
  const deps: CaptureDeps = {
    fetch: fetchStub,
    keys: {
      list: async () => options.keys ?? [],
      reveal: async () => options.revealed,
    },
    openMicrophone: async () => {
      if (options.holdMicrophone) await new Promise<void>((resolve) => (grant = resolve));
      micOpen = true;
      return {
        stream: {} as MediaStream,
        close: () => {
          micOpen = false;
        },
      };
    },
    createAudioContext: () => undefined,
    createEngine: createDebriefEngine,
    createClient: createSessionClient,
    createAdapter: () => {
      if (options.adapter) return options.adapter();
      throw new Error("real adapters aren't used here");
    },
    ...(options.witnessSetting !== undefined
      ? { witnessSetting: () => options.witnessSetting ?? null }
      : {}),
    ...(options.createWitness ? { createWitness: options.createWitness } : {}),
    clock: () => clock.now(),
    now: () => new Date("2026-11-19T12:00:00.000Z"),
    timeZone: () => "Europe/Lisbon",
    online: () => true,
    ios: false,
    speech: new SpokenConfirmations(undefined),
    chime: () => chimes.push(clock.now()),
    timers: {
      setTimeout: (cb, ms) => clock.setTimeout(cb, ms),
      clearTimeout: (h) => clock.clearTimeout(h),
    },
    clientOptions: {
      socket: server.factory,
      clock,
      random: () => 0.5,
      page: new FakePageLifecycle(),
    },
    engineOptions: {
      capture: (captureOptions) => {
        const source = new FakeCaptureSource();
        captures.push(source);
        return source.factory()(captureOptions);
      },
      // Hands-free's VAD, which never hears speech here: the engine streams on arming regardless.
      vad: async () => ({ start: async () => {}, pause: async () => {}, destroy: async () => {} }),
      clock,
      random: () => 0.5,
    },
  };
  const controller = new CaptureController(deps);
  return {
    clock,
    server,
    /** The capture source of the engine started last. */
    get capture(): FakeCaptureSource {
      const source = captures.at(-1);
      if (!source) throw new Error("no engine has started yet");
      return source;
    },
    controller,
    routes,
    chimes,
    micOpen: () => micOpen,
    grantMicrophone: () => grant?.(),
  };
}

/** Speaks `ms` into the running engine's microphone, in real time, without pressing anything. */
async function speak(t: ReturnType<typeof setup>, ms: number) {
  for (let done = 0; done < ms; done += 32) {
    t.capture.speak(32);
    await t.clock.advance(32);
  }
}

/** One push-to-talk turn, through its answer. Returns when push-to-talk went up. */
async function talk(t: ReturnType<typeof setup>, ms: number): Promise<number> {
  t.controller.press();
  await speak(t, ms);
  const releasedAt = t.clock.now();
  t.controller.release(releasedAt);
  await t.clock.advance(1_500);
  await settle(100);
  await t.clock.advance(300);
  return releasedAt;
}

describe("CaptureController in fake mode", () => {
  it("runs a debrief: start with the scenario's context, a turn per press, marks, and the end", async () => {
    const t = setup();
    const fake = createFakeVoice(SCENARIO);
    t.controller.start({ selection: null, fake });
    await settle(100);
    await t.clock.advance(200);
    expect(t.controller.getState().phase).toBe("live");
    expect(t.controller.getState().capture.state).toBe("armed");
    expect(t.micOpen()).toBe(true);
    expect(t.routes[0]).toEqual({
      url: "/api/sessions",
      body: {
        mode: "debrief",
        engine: "cascaded",
        providers: { speechToText: { provider: "fake", model: "fake" }, llm: SCENARIO.llm },
      },
    });
    // The cassettes were recorded with the scenario's entities, open account, call time, and
    // zone, not the CRM's.
    const [start] = t.server.received.filter((m) => m.t === "start");
    expect(start).toMatchObject({
      entities: SCENARIO.entities,
      focusEntityId: SCENARIO.focusEntityId,
      startedAt: SCENARIO.startedAt,
      timeZone: SCENARIO.timeZone,
    });

    await talk(t, fake.holdMs);
    const state = t.controller.getState();
    const session = state.store?.getState();
    expect(session?.projections.utterances.map((u) => u.text)).toEqual([
      "Met Dana Lee at Acme Corp",
    ]);
    expect(session?.projections.proposals.map((p) => p.type)).toEqual(["contact"]);
    expect(state.turnsSent).toBe(1);
    expect(state.fake?.nextLine).toBe("That is all");
    const turnEnds = t.server.received.filter((m) => m.t === "turn_end");
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]).toMatchObject({
      key: fake.turnKey,
      llm: SCENARIO.llm,
      trigger: "ptt_release",
    });

    // The card's paint is the turn's last mark; the metric follows it, once.
    const proposalId = session?.projections.proposals[0]?.proposalId ?? "";
    t.controller.cardPainted(proposalId, t.clock.now() + 12);
    t.controller.cardPainted(proposalId, t.clock.now() + 50);
    await settle(50);
    await t.clock.advance(300);
    const metrics = t.server.received.filter((m) => m.t === "metric");
    expect(metrics).toHaveLength(1);
    const marks = (metrics[0] as { marks: Record<string, number | string> }).marks;
    expect(marks.mode).toBe("push_to_talk");
    expect(Number(marks.speechEndMs)).toBeLessThanOrEqual(Number(marks.proposalMs));
    expect(Number(marks.proposalMs)).toBeLessThanOrEqual(Number(marks.paintMs));

    // A press with nothing to propose: the silent-response chime plays (output is safe here).
    await talk(t, fake.holdMs);
    expect(
      t.controller
        .getState()
        .store?.getState()
        .turns.map((turn) => turn.completed?.outcome),
    ).toEqual(["proposals", "nothing_to_propose"]);
    expect(t.chimes).toHaveLength(1);

    const ending = t.controller.end();
    await settle(100);
    await t.clock.advance(1_000);
    await ending;
    expect(t.controller.getState().phase).toBe("ended");
    expect(t.micOpen()).toBe(false);
    expect(t.server.received.some((m) => m.t === "end")).toBe(true);
    // The placeholder key went out only inside turn_end.
    for (const message of t.server.received) {
      if (message.t !== "turn_end") expect(JSON.stringify(message)).not.toContain(fake.turnKey);
    }
    expect(JSON.stringify(t.controller.getState().store?.getState())).not.toContain(fake.turnKey);
    t.controller.dispose();
  });

  it("closes a microphone granted after the debrief ended, and starts no engine", async () => {
    const t = setup({ holdMicrophone: true });
    t.controller.start({ selection: null, fake: createFakeVoice(SCENARIO) });
    await settle(100);
    await t.clock.advance(200);
    // The session is ready while the rep is still looking at the microphone prompt.
    expect(t.controller.getState().phase).toBe("live");
    expect(t.micOpen()).toBe(false);
    await t.controller.end();
    expect(t.controller.getState().phase).toBe("ended");

    t.grantMicrophone(); // the rep answers the prompt after ending
    await settle(100);
    await t.clock.advance(200);
    expect(t.micOpen()).toBe(false);
    expect(t.controller.getState().capture.state).not.toBe("armed");
    expect(t.server.received.some((m) => m.t === "utterance")).toBe(false);
  });

  it("pauses live updates on screen without stopping capture", async () => {
    const t = setup();
    t.controller.start({ selection: null, fake: createFakeVoice(SCENARIO) });
    await settle(100);
    await t.clock.advance(200);
    t.controller.togglePause();
    expect(t.controller.getState().paused).toBe(true);
    await talk(t, 1_600);
    const ui = t.controller.getState();
    expect(ui.frozen?.projections.utterances).toHaveLength(0);
    expect(ui.store?.getState().projections.utterances).toHaveLength(1);
    t.controller.togglePause();
    expect(t.controller.getState().frozen).toBeNull();
    t.controller.dispose();
  });

  it("carries the session's audio clock across `H`, so a new engine's utterances come after the old one's", async () => {
    const t = setup();
    const fake = createFakeVoice(THREE_LINES);
    t.controller.start({ selection: null, fake });
    await settle(100);
    await t.clock.advance(200);
    await talk(t, fake.holdMs); // engine 1, push-to-talk: 1,600 ms of audio

    t.controller.toggleHandsFree(); // engine 2, hands-free, streams 1,600 ms from arming
    await settle(100);
    await t.clock.advance(200);
    expect(t.controller.getState().capture.state).toBe("armed");
    await speak(t, fake.holdMs);
    t.controller.toggleHandsFree(); // engine 2 ends its turn as it stops; engine 3 is push-to-talk
    await settle(100);
    await t.clock.advance(1_500);
    await talk(t, fake.holdMs); // engine 3

    const utterances = t.controller.getState().store?.getState().projections.utterances ?? [];
    expect(utterances).toHaveLength(3);
    // Each engine's audio starts where the last one's stopped, not at 0 again.
    expect(utterances.map((u) => u.startMs)).toEqual([0, 1_600, 3_200]);
    for (let i = 1; i < utterances.length; i++) {
      expect(utterances[i]?.startMs).toBeGreaterThan(utterances[i - 1]?.endMs ?? Infinity);
    }
    t.controller.dispose();
  });

  it("carries the session's audio clock across a pause and resume", async () => {
    const t = setup();
    const fake = createFakeVoice(SCENARIO);
    t.controller.start({ selection: null, fake });
    await settle(100);
    await t.clock.advance(200);
    await talk(t, fake.holdMs);
    t.controller.pauseCapture();
    t.controller.resumeCapture(); // while the paused engine is still stopping
    await settle(100);
    await t.clock.advance(200);
    expect(t.controller.getState().capture.state).toBe("armed");
    await talk(t, fake.holdMs);
    const utterances = t.controller.getState().store?.getState().projections.utterances ?? [];
    expect(utterances.map((u) => [u.text, u.startMs])).toEqual([
      ["Met Dana Lee at Acme Corp", 0],
      ["That is all", 1_600],
    ]);
    t.controller.dispose();
  });

  it("counts and marks the turn that `H` ends mid-press, and moves on to the scenario's next line", async () => {
    const t = setup();
    const fake = createFakeVoice(THREE_LINES);
    t.controller.start({ selection: null, fake });
    await settle(100);
    await t.clock.advance(200);
    const utterances = () =>
      t.controller
        .getState()
        .store?.getState()
        .projections.utterances.map((u) => u.text);
    const paint = async () => {
      const proposals = t.controller.getState().store?.getState().projections.proposals ?? [];
      for (const proposal of proposals)
        t.controller.cardPainted(proposal.proposalId, t.clock.now());
      await settle(50);
      await t.clock.advance(300);
    };

    // `H` while push-to-talk is still held: the switch releases it, and the old engine ends the
    // turn as it stops.
    t.controller.press();
    await speak(t, fake.holdMs);
    const switchedAt = t.clock.now();
    t.controller.toggleHandsFree();
    await settle(100);
    await t.clock.advance(1_500);
    expect(t.controller.getState()).toMatchObject({
      mode: "hands_free",
      turnsSent: 1,
      fake: { nextLine: "That is all" },
    });
    expect(utterances()).toEqual(["Met Dana Lee at Acme Corp"]);
    // Its marks are whole, in its own mode, with the speech ending at the switch.
    await paint();
    const metrics = () =>
      t.server.received.flatMap((m) =>
        m.t === "metric" ? [{ turnId: m.turnId, ...m.marks }] : [],
      );
    expect(metrics()).toEqual([
      expect.objectContaining({ mode: "push_to_talk", speechEndMs: switchedAt }),
    ]);

    // The hands-free engine says the next line, not the first again, and its turn counts too.
    await speak(t, fake.holdMs);
    t.controller.toggleHandsFree();
    await settle(100);
    await t.clock.advance(1_500);
    expect(t.controller.getState()).toMatchObject({
      turnsSent: 2,
      fake: { nextLine: "Dana Lee wants the pricing deck by Friday" },
    });

    // So does engine 3, and its marks start from its own release, not the switch's.
    const releasedAt = await talk(t, fake.holdMs);
    await paint();
    expect(utterances()).toEqual([
      "Met Dana Lee at Acme Corp",
      "That is all",
      "Dana Lee wants the pricing deck by Friday",
    ]);
    expect(t.controller.getState()).toMatchObject({ turnsSent: 3, fake: { nextLine: null } });
    expect(metrics().map((marks) => [marks.mode, marks.speechEndMs])).toEqual([
      ["push_to_talk", switchedAt],
      ["push_to_talk", releasedAt],
    ]);
    t.controller.dispose();
  });
});

describe("CaptureController's tray after `end` (Phase 5 WP6)", () => {
  /** A review of the session's first card, as the tray sends it. */
  function trayReview(t: ReturnType<typeof setup>) {
    const proposal = t.controller.getState().store?.getState().projections.proposals[0];
    if (!proposal) throw new Error("no card");
    return decisionReview({
      proposal,
      entities: {},
      decision: "rejected",
      timing: { decisionMs: 800, handlingMs: 800 },
      input: "keyboard",
      surface: "tray",
    });
  }

  async function endedWithACard(t: ReturnType<typeof setup>) {
    const fake = createFakeVoice(SCENARIO);
    t.controller.start({ selection: null, fake });
    await settle(100);
    await t.clock.advance(200);
    await talk(t, fake.holdMs);
    const ending = t.controller.end();
    await settle(100);
    await t.clock.advance(1_000);
    await ending;
    expect(t.controller.getState().phase).toBe("ended");
  }

  const connection = (t: ReturnType<typeof setup>) =>
    t.controller.getState().store?.getState().connection.state;

  it("keeps the client open until the seal, takes the tray's reviews over the socket meanwhile, then hands over", async () => {
    const t = setup();
    await endedWithACard(t);
    const writer = t.controller.getState().reviews;
    expect(writer?.sessionId).toBe(SESSION_ID);
    // Long past `end`'s late events: still open for the tray, unlike before Phase 5.
    await t.clock.advance(20_000);
    expect(connection(t)).toBe("open");

    // A tray review in the grace goes over the socket, and SessionDO writes it.
    const sink = socketSink(writer as NonNullable<typeof writer>);
    const review = trayReview(t);
    const sent = sink.send(SESSION_ID, { reviews: [review], snoozes: [] });
    await settle(200);
    // With the seq SessionDO's ack says the write reached, for the tray's reconcile.
    await expect(sent).resolves.toEqual({ ok: true, seq: expect.any(Number) });
    expect(t.server.log.at(-1)?.payload).toMatchObject({ reviewId: review.reviewId });

    // The seal: the tray hands over, and the client closes once its late events are in.
    t.server.seal();
    await settle(200);
    expect(t.controller.getState().sealed).toBe(true);
    await t.clock.advance(6_000);
    expect(connection(t)).toBe("closed");

    // After it, a tray review goes to the web route, under the same id.
    const proposal = t.controller.getState().store?.getState().projections.proposals[0];
    if (!proposal) throw new Error("no card");
    const reopened = undoReview({
      proposal,
      entities: {},
      undoes: review.reviewId,
      input: "pointer",
      surface: "tray",
    });
    // With the route's `lastSeq`, as the socket's ack gave before the seal.
    await expect(sink.send(SESSION_ID, { reviews: [reopened], snoozes: [] })).resolves.toEqual({
      ok: true,
      seq: expect.any(Number),
    });
    const posted = t.routes.filter((route) => route.url.endsWith("/reviews"));
    expect(posted).toHaveLength(1);
    const body = posted[0]?.body as { reviews: { reviewId: string }[] } | undefined;
    expect(body?.reviews.map((posting) => posting.reviewId)).toEqual([reopened.reviewId]);
    t.controller.dispose();
  });

  it("stops waiting for the seal when the rep leaves the capture screen", async () => {
    const t = setup();
    await endedWithACard(t);
    t.controller.leaveScreen();
    await t.clock.advance(6_000);
    expect(connection(t)).toBe("closed");
    expect(t.controller.getState().sealed).toBe(false);
    t.controller.dispose();
  });

  it("gives up waiting at the seal's cap, 31 minutes after `end`", async () => {
    const t = setup();
    await endedWithACard(t);
    await t.clock.advance(30 * 60_000);
    expect(connection(t)).toBe("open");
    await t.clock.advance(70_000);
    expect(connection(t)).toBe("closed");
    t.controller.dispose();
  }, 120_000);
});

describe("CaptureController before a session", () => {
  it("needs a speech-to-text key and a model key on this device", async () => {
    const t = setup({ keys: [] });
    t.controller.start({ selection: { stt: "assemblyai:default", llm: "groq:default" } });
    await settle(100);
    await t.clock.advance(100);
    const state = t.controller.getState();
    expect(state.phase).toBe("setup");
    expect(state.problem).toEqual({ kind: "missing_key" });
    expect(t.micOpen()).toBe(false);
    expect(t.routes).toEqual([]);
  });

  it("says why the session route refused, and releases the microphone", async () => {
    const keys: StoredKeyMeta[] = [
      { provider: "assemblyai", label: "default", last4: "abcd", addedAt: "2026-11-19T00:00:00Z" },
      { provider: "groq", label: "default", last4: "wxyz", addedAt: "2026-11-19T00:00:00Z" },
    ];
    const t = setup({ keys, revealed: "gsk_canary0123456789abcdefghijklmnop", sessionStatus: 429 });
    t.controller.start({ selection: { stt: "assemblyai:default", llm: "groq:default" } });
    await settle(100);
    await t.clock.advance(100);
    expect(t.controller.getState().problem).toEqual({
      kind: "session",
      error: "too_many_requests",
      retryAfterSeconds: 120,
    });
    expect(t.controller.getState().phase).toBe("setup");
    expect(t.micOpen()).toBe(false);
    expect(t.routes.map((route) => route.url)).toEqual(["/api/sessions"]);
    expect(JSON.stringify(t.routes)).not.toContain("gsk_canary");
  });
});

describe("CaptureController with the second witness", () => {
  const KEYS: StoredKeyMeta[] = [
    { provider: "assemblyai", label: "default", last4: "abcd", addedAt: "2026-11-19T00:00:00Z" },
    { provider: "anthropic", label: "default", last4: "efgh", addedAt: "2026-11-19T00:00:00Z" },
    { provider: "groq", label: "default", last4: "wxyz", addedAt: "2026-11-19T00:00:00Z" },
  ];
  const SELECTION = { stt: "assemblyai:default", llm: "anthropic:default" };
  const KEY = "gsk_witnesscanary0123456789abcdefghijklmn";
  const realAdapter = () =>
    createFakeSttAdapter({
      script: { turns: [{ text: "Met Dana Lee at Acme Corp", startMs: 0, endMs: 1_200 }] },
      endpointingMs: 10 * 60_000,
    });

  async function startReal(t: ReturnType<typeof setup>) {
    t.controller.start({ selection: SELECTION });
    await settle(100);
    await t.clock.advance(200);
    expect(t.controller.getState().phase).toBe("live");
  }

  it("with the device's consent and a Groq key, runs the Groq witness on each turn's audio after its turn_end", async () => {
    const keyReads: (() => Promise<string | undefined>)[] = [];
    const runner = createFakeWitness({
      script: { turns: [{ text: "Met Dana Lee at Akme Corp", latencyMs: 640 }] },
    });
    const t = setup({
      keys: KEYS,
      revealed: KEY,
      adapter: realAdapter,
      witnessSetting: "groq",
      createWitness: (key) => {
        keyReads.push(key);
        return runner;
      },
    });
    await startReal(t);
    expect(t.controller.getState().witness).toEqual({ status: "on", source: "groq" });
    await talk(t, 1_800);
    // The microphone carries on after the release: the turn's 200 ms tail comes in.
    for (let done = 0; done < 320; done += 32) {
      t.capture.silence(32);
      await t.clock.advance(32);
    }
    await settle(100);
    // The witness's runner got the turn's audio, from the press on the session's clock.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.turnStartMs).toBe(0);
    expect(runner.calls[0]?.samples).toBeGreaterThanOrEqual(1_800 * 16);
    const types = t.server.received.map((m) => m.t);
    expect(types.indexOf("witness")).toBeGreaterThan(types.indexOf("turn_end"));
    const [witness] = t.server.received.filter((m) => m.t === "witness");
    expect(witness).toMatchObject({
      provider: "groq",
      model: "whisper-large-v3-turbo",
      outcome: "transcribed",
      latencyMs: 640,
      utterance: { text: "Met Dana Lee at Akme Corp", witness: "unbiased" },
    });
    expect(
      t.server.received.some((m) => m.t === "usage" && m.provider === "groq" && m.socketMs === 0),
    ).toBe(true);
    // The Groq key is read from the device per request. (This stub reveals one key for every
    // provider, so the same string is also this turn's LLM key: only turn_end may carry it.)
    expect(keyReads).toHaveLength(1);
    await expect(keyReads[0]?.()).resolves.toBe(KEY);
    for (const message of t.server.received) {
      if (message.t !== "turn_end") expect(JSON.stringify(message)).not.toContain(KEY);
    }
    t.controller.dispose();
  });

  it("says why there's no witness: off without consent, no_key when the Groq key is gone", async () => {
    const off = setup({ witnessSetting: null });
    off.controller.start({ selection: null, fake: createFakeVoice(SCENARIO) });
    await settle(100);
    await off.clock.advance(200);
    expect(off.controller.getState().witness).toEqual({ status: "off", source: "fake" });
    await talk(off, 1_600);
    expect(off.server.received.filter((m) => m.t === "witness")).toMatchObject([
      { outcome: "skipped", reason: "off" },
    ]);
    off.controller.dispose();

    const created: unknown[] = [];
    const noKey = setup({
      keys: KEYS.filter((key) => key.provider !== "groq"),
      revealed: KEY,
      adapter: realAdapter,
      witnessSetting: "groq",
      createWitness: (key) => {
        created.push(key);
        return createFakeWitness({ script: { turns: [] } });
      },
    });
    await startReal(noKey);
    expect(noKey.controller.getState().witness).toEqual({ status: "no_key", source: "groq" });
    await talk(noKey, 1_800);
    expect(noKey.server.received.filter((m) => m.t === "witness")).toMatchObject([
      { outcome: "skipped", reason: "no_key" },
    ]);
    expect(created).toEqual([]);
    noKey.controller.dispose();
  });

  it("holds `end` until the last turn's witness is in the outbox, so SessionDO takes it", async () => {
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const t = setup({
      keys: KEYS,
      revealed: KEY,
      adapter: realAdapter,
      witnessSetting: "groq",
      createWitness: () =>
        createFakeWitness({
          script: { turns: [{ text: "Met Dana Lee at Acme Corp" }] },
          gate: () => answered,
        }),
    });
    await startReal(t);
    await talk(t, 1_800);
    const ending = t.controller.end();
    await settle(100);
    await t.clock.advance(1_000);
    expect(t.server.received.some((m) => m.t === "end")).toBe(false); // waiting on Groq
    answer();
    await settle(100);
    await t.clock.advance(1_000);
    await ending;
    const types = t.server.received.map((m) => m.t);
    expect(types.indexOf("witness")).toBeGreaterThan(-1);
    expect(types.indexOf("witness")).toBeLessThan(types.indexOf("end"));
    t.controller.dispose();
  });
});
