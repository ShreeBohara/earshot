// The capture controller end to end on WP8's fakes: an in-memory SessionDO, the fake adapter, a
// scripted capture source, and a manual clock. No browser, no network, no provider.
import type { StoredKeyMeta } from "@earshot/keys";
import { createDebriefEngine } from "@earshot/voice";
import { createSessionClient } from "@earshot/voice/session";
import {
  FakeCaptureSource,
  FakePageLifecycle,
  FakeSessionServer,
  settle,
} from "@earshot/voice/testing";
import { describe, expect, it } from "vitest";
import { SpokenConfirmations } from "@/lib/capture/audio-out";
import { CaptureController, type CaptureDeps } from "@/lib/capture/controller";
import { createFakeVoice } from "@/lib/capture/dev/fake-voice";
import type { FakeScenario } from "@/lib/capture/fake";
import { ManualClock } from "./support/manual-clock";

const SESSION_ID = "0000000a-0000-7000-8000-0000000ca901";

const SCENARIO: FakeScenario = {
  version: 1,
  name: "test",
  startedAt: "2026-11-10T19:15:00.000Z",
  timeZone: "America/Los_Angeles",
  entities: [{ id: "co_1", kind: "company", name: "Acme Corp", aliases: ["Acme"] }],
  llm: { provider: "anthropic", model: "claude-haiku-5-5" },
  turns: [{ text: "Met Dana Lee at Acme Corp" }, { text: "That is all" }],
};

function setup(
  options: { keys?: StoredKeyMeta[]; revealed?: string; sessionStatus?: number } = {},
) {
  const clock = new ManualClock();
  const server = new FakeSessionServer({
    sessionId: SESSION_ID,
    propose: (turn) =>
      turn.utterances
        .filter((u) => u.text.includes("Dana"))
        .map((u) => ({
          type: "contact" as const,
          targetEntityId: null,
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
          riskFlags: [{ kind: "new_entity" as const }],
        })),
  });
  const capture = new FakeCaptureSource();
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
          keyterms: { assemblyai: ["Real CRM Co"], deepgram: ["Real CRM Co"] },
        },
        { status: 201 },
      );
    }
    if (url.endsWith("/ticket")) {
      const next = ticket();
      return Response.json(next);
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;

  let micOpen = false;
  const chimes: number[] = [];
  const deps: CaptureDeps = {
    fetch: fetchStub,
    keys: {
      list: async () => options.keys ?? [],
      reveal: async () => options.revealed,
    },
    openMicrophone: async () => {
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
      throw new Error("real adapters aren't used here");
    },
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
    engineOptions: { capture: capture.factory(), clock, random: () => 0.5 },
  };
  const controller = new CaptureController(deps);
  return { clock, server, capture, controller, routes, chimes, micOpen: () => micOpen };
}

async function talk(t: ReturnType<typeof setup>, ms: number) {
  t.controller.press();
  for (let done = 0; done < ms; done += 32) {
    t.capture.speak(32);
    await t.clock.advance(32);
  }
  t.controller.release(t.clock.now());
  await t.clock.advance(1_500);
  await settle(100);
  await t.clock.advance(300);
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
    // The cassettes were recorded with the scenario's entities, call time, and zone, not the CRM's.
    const [start] = t.server.received.filter((m) => m.t === "start");
    expect(start).toMatchObject({
      entities: SCENARIO.entities,
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
