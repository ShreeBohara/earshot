// SessionClient against the in-memory SessionDO (`FakeSessionServer`), on a manual clock. The
// fake follows WP6's server where the client can tell: tickets, welcome and replay, msgId dedupe,
// acks to every socket, `working`, close codes, and ping/pong.
import {
  type EventEnvelope,
  MAX_MESSAGE_BYTES,
  SESSION_CLOSE_CODES,
  type SessionCloseName,
  type UtteranceFinalV2,
} from "@earshot/core";
import { defaultProjections, fromJsonl, replay } from "@earshot/events";
import { demoSessionId, demoSessionJsonl } from "@earshot/events/testing";
import { describe, expect, it, vi } from "vitest";
import {
  createSessionClient,
  MessageRefusedError,
  type SessionClient,
  type SessionClientOptions,
  SessionClosedError,
} from "../src/session/client";
import { Outbox } from "../src/session/outbox";
import { SessionStore } from "../src/session/store";
import { SessionTicketError } from "../src/session/ticket";
import { FakePageLifecycle } from "../src/testing/fake-page";
import {
  type FakeProposal,
  FakeSessionServer,
  type FakeSessionServerOptions,
  NO_TARGET,
} from "../src/testing/fake-session-server";
import { settle } from "../src/testing/fake-socket";
import { counterIds } from "./support/ids";
import { ManualClock } from "./support/manual-clock";

const SESSION = "0000000a-0000-7000-8000-00000000a11c";
const KEY = "sk-ant-canary-0123456789abcdefghijklmnop";
const demo = fromJsonl(demoSessionJsonl);

const PROVIDERS = {
  speechToText: { provider: "assemblyai", model: "universal-streaming-english" },
  llm: { provider: "anthropic", model: "claude-haiku-5-5" },
};

let utteranceCount = 0;
function utterance(text = "Acme wants the proposal by Friday."): UtteranceFinalV2 {
  utteranceCount += 1;
  return {
    utteranceId: `0000000d-0000-7000-8000-${utteranceCount.toString(16).padStart(12, "0")}`,
    text,
    confidence: 0.92,
    startMs: 1_000 * utteranceCount,
    endMs: 1_000 * utteranceCount + 800,
    witness: "biased",
  };
}

let turnCount = 0;
const newTurnId = () => {
  turnCount += 1;
  return `0000000c-0000-7000-8000-${turnCount.toString(16).padStart(12, "0")}`;
};

const proposalFor = (quoted: UtteranceFinalV2): FakeProposal => ({
  type: "task",
  target: NO_TARGET,
  fields: {
    title: {
      value: "Send the proposal",
      evidence: {
        utteranceId: quoted.utteranceId,
        span: [0, 4],
        audioMs: [1000, 1400],
        confidence: 0.9,
      },
    },
  },
  riskFlags: [],
});

interface HarnessOptions {
  readonly sessionId?: string;
  readonly server?: Partial<FakeSessionServerOptions>;
  readonly client?: Partial<SessionClientOptions>;
  readonly page?: FakePageLifecycle;
  readonly seed?: readonly EventEnvelope[];
  readonly server_?: FakeSessionServer;
}

function harness(options: HarnessOptions = {}) {
  const sessionId = options.sessionId ?? SESSION;
  const clock = new ManualClock();
  const server =
    options.server_ ??
    new FakeSessionServer({
      sessionId,
      propose: (turn) => turn.utterances.slice(0, 1).map(proposalFor),
      ...options.server,
    });
  if (options.seed) server.seed(options.seed);
  const page = options.page ?? new FakePageLifecycle();
  const logs: string[] = [];
  let ticketCalls = 0;
  const client = createSessionClient({
    sessionId,
    url: server.edgeUrl,
    socket: server.factory,
    clock,
    random: () => 0.5,
    createId: counterIds(),
    page,
    getTicket: async () => {
      ticketCalls += 1;
      return server.issueTicket();
    },
    log: { debug: (event, fields) => logs.push(JSON.stringify([event, fields ?? {}])) },
    ...options.client,
  });
  const snapshots: string[] = [];
  client.store.subscribe(() => snapshots.push(JSON.stringify(client.store.getState())));
  return {
    clock,
    server,
    client,
    page,
    logs,
    snapshots,
    ticketCalls: () => ticketCalls,
    flush: () => settle(400),
  };
}

type Harness = ReturnType<typeof harness>;

async function open(h: Harness): Promise<void> {
  h.client.start();
  await h.flush();
  expect(h.client.connection.state).toBe("open");
}

async function started(h: Harness): Promise<void> {
  await open(h);
  h.client.sendStart({ providers: PROVIDERS, startedAt: "2026-11-19T12:00:00.000Z", entities: [] });
  await h.flush();
}

const hellos = (server: FakeSessionServer) =>
  server.received.filter((message) => message.t === "hello").map((message) => message.lastSeq);

const seqs = (client: SessionClient) => client.store.getState().events.map((event) => event.seq);

describe("SessionClient: connecting", () => {
  it("connects with a fresh ticket in the subprotocols, says hello, and opens on welcome", async () => {
    const h = harness();
    await open(h);
    const socket = h.server.sockets[0];
    expect(socket?.protocols).toEqual(["earshot.v1", "earshot.ticket.fake-ticket-1"]);
    expect(socket?.url.href).toBe(h.server.edgeUrl); // the ticket stays out of the URL
    expect(socket?.url.href).not.toContain("fake-ticket");
    expect(h.server.received).toEqual([{ t: "hello", protocol: 1, lastSeq: -1 }]);
    expect(h.client.connection).toMatchObject({ state: "open", attempt: 0, reason: null });
  });

  it("fetches a ticket for every connect, using the first answer's ticket only once", async () => {
    const server = new FakeSessionServer({ sessionId: SESSION });
    const initial = server.issueTicket();
    const h = harness({ server_: server, client: { initialTicket: initial } });
    await open(h);
    expect(h.ticketCalls()).toBe(0); // the session's first ticket opened the first socket
    expect(h.server.sockets.map((s) => s.protocols[1])).toEqual([
      `earshot.ticket.${initial.ticket}`,
    ]);
    for (let drop = 1; drop <= 3; drop++) {
      h.server.dropAll(1006);
      await h.flush();
      await h.clock.advance(250);
      await h.flush();
      expect(h.client.connection.state).toBe("open");
      expect(h.ticketCalls()).toBe(drop);
    }
    const used = h.server.sockets.map((s) => s.protocols[1]);
    expect(new Set(used).size).toBe(4); // four connects, four tickets, none reused
  });

  it("doesn't spend an initial ticket that's about to expire", async () => {
    const h = harness({
      client: {
        initialTicket: {
          ticket: "stale",
          ticketExpiresAt: new Date(Date.now() + 1_000).toISOString(),
        },
      },
    });
    await open(h);
    expect(h.ticketCalls()).toBe(1);
    expect(h.server.sockets[0]?.protocols[1]).toBe("earshot.ticket.fake-ticket-1");
  });

  it("starts the session and folds what SessionDO appends", async () => {
    const h = harness();
    await started(h);
    const state = h.client.store.getState();
    expect(state.projections.session).toMatchObject({ sessionId: SESSION, status: "active" });
    expect(state.pending).toBe(0);
    expect(h.server.commits.size).toBe(1);
  });
});

describe("SessionClient: resume (the client half of G2)", () => {
  it("resumes after a drop with no lost and no duplicate events, matching replay()", async () => {
    const h = harness({ sessionId: demoSessionId, seed: demo });
    h.server.dropAfter.set(7, SESSION_CLOSE_CODES.going_away.code);
    const applied: number[] = [];
    h.client.store.subscribe(() => {
      const { lastSeq } = h.client.store.getState();
      if (applied.at(-1) !== lastSeq) applied.push(lastSeq);
    });
    h.client.start();
    await h.flush();
    expect(h.client.connection.state).toBe("backoff");
    expect(h.client.store.getState().lastSeq).toBe(7);
    await h.clock.advance(250);
    await h.flush();
    expect(h.client.connection.state).toBe("open");
    expect(hellos(h.server)).toEqual([-1, 7]);
    expect(applied.filter((seq) => seq >= 0)).toEqual(demo.map((event) => event.seq));
    expect(seqs(h.client)).toEqual(demo.map((event) => event.seq));
    expect(h.client.store.getState().events.map((event) => event.id)).toEqual(
      demo.map((event) => event.id),
    );
    expect(h.client.store.getState().projections).toStrictEqual(replay(demo, defaultProjections));
  });

  it("survives drops at every point of the demo log and still folds what replay() builds", async () => {
    for (let at = 0; at < demo.length; at += 3) {
      const h = harness({ sessionId: demoSessionId, seed: demo });
      h.server.dropAfter.set(at, 1006);
      h.server.dropAfter.set(Math.min(demo.length - 1, at + 2), 4000);
      h.client.start();
      for (let i = 0; i < 6; i++) {
        await h.flush();
        await h.clock.advance(1_000);
      }
      expect(seqs(h.client)).toEqual(demo.map((event) => event.seq));
      expect(h.client.store.getState().projections).toStrictEqual(replay(demo, defaultProjections));
      h.client.stop();
    }
  });

  it("resends unacknowledged messages after a reconnect, and SessionDO does each once", async () => {
    const h = harness();
    await started(h);
    h.server.holdTurns = true;
    const turnId = newTurnId();
    const said = utterance();
    const utteranceId = h.client.sendUtterance(turnId, said);
    const turnEndId = h.client.sendTurnEnd({
      turnId,
      trigger: "ptt_release",
      llm: { provider: "anthropic", model: "claude-haiku-5-5" },
      key: KEY,
    });
    await h.flush();
    expect(h.client.store.getState().pending).toBe(1); // the turn runs; its ack waits
    h.server.dropAll(1006);
    await h.flush();
    const usageId = h.client.sendUsage({
      provider: "assemblyai",
      model: "universal-streaming-english",
      audioMs: 4_200,
      socketMs: 6_100.4,
    });
    await h.flush();
    expect(h.client.store.getState().pending).toBe(2);
    await h.clock.advance(250);
    await h.flush();
    // The new socket carried the turn_end again and the usage for the first time, in order.
    const resent = h.server.current?.messages.filter((m) => m.t !== "hello" && m.t !== "ack");
    expect(resent?.map((m) => m.t)).toEqual(["turn_end", "usage"]);
    h.server.completeTurns();
    await h.flush();
    const state = h.client.store.getState();
    expect(state.pending).toBe(0);
    for (const msgId of [utteranceId, turnEndId, usageId]) {
      expect(h.server.commits.get(msgId ?? "")).toBe(1);
    }
    expect(state.projections.proposals).toHaveLength(1);
    expect(state.turns[0]?.completed?.outcome).toBe("proposals");
    expect(state.meter.stt).toMatchObject({ audioMs: 4_200, socketMs: 6_100 });
  });

  it("asks again on the same socket when a seq is skipped", async () => {
    const h = harness({ sessionId: demoSessionId, seed: demo });
    h.server.skipOnce.add(3);
    h.client.start();
    await h.flush();
    expect(h.server.sockets).toHaveLength(1);
    expect(hellos(h.server)).toEqual([-1, 2]);
    expect(h.client.connection.state).toBe("open");
    expect(seqs(h.client)).toEqual(demo.map((event) => event.seq));
    expect(h.logs.some((line) => line.includes('"gap"'))).toBe(true);
  });

  it("gives up as out of sync when the same gap keeps coming back", async () => {
    const h = harness({ sessionId: demoSessionId, seed: demo });
    h.server.withhold.add(3);
    h.client.start();
    await h.flush();
    expect(hellos(h.server)).toEqual([-1, 2, 2, 2]);
    expect(h.client.connection).toMatchObject({ state: "closed", reason: "desynced" });
    expect(h.client.store.getState().lastSeq).toBe(2);
  });

  it("refuses a welcome from a server that has lost events it folded", async () => {
    const h = harness({ sessionId: demoSessionId, seed: demo });
    await open(h);
    // The session's storage was wiped and a fresh object answers with an empty log.
    const fresh = new FakeSessionServer({ sessionId: demoSessionId });
    const client = createSessionClient({
      sessionId: demoSessionId,
      url: fresh.edgeUrl,
      socket: fresh.factory,
      clock: h.clock,
      page: h.page,
      store: h.client.store,
      getTicket: async () => fresh.issueTicket(),
    });
    h.client.stop();
    client.start();
    await h.flush();
    expect(client.connection).toMatchObject({ state: "closed", reason: "desynced" });
    expect(client.store.getState().issues.at(-1)?.code).toBe("desynced");
  });
});

describe("SessionClient: close codes", () => {
  const names = Object.keys(SESSION_CLOSE_CODES) as SessionCloseName[];

  it.each(names)("follows %s's reconnect flag", async (name) => {
    const { code, reconnect } = SESSION_CLOSE_CODES[name];
    const h = harness();
    await open(h);
    h.server.current?.socket.close(code, SESSION_CLOSE_CODES[name].reason);
    await h.flush();
    if (!reconnect) {
      expect(h.client.connection).toMatchObject({ state: "closed", reason: name, lastCode: code });
      await h.clock.advance(120_000);
      await h.flush();
      expect(h.server.sockets).toHaveLength(1);
      expect(h.ticketCalls()).toBe(1);
      return;
    }
    if (name === "ticket_refused" || name === "ticket_reused") {
      // A fresh ticket at once, no backoff.
      expect(h.client.connection.state).toBe("open");
    } else {
      expect(h.client.connection.state).toBe("backoff");
      const waitMs = (h.client.connection.retryAt ?? 0) - h.clock.now();
      expect(waitMs).toBe(name === "rate_limited" ? 5_000 : 250);
      await h.clock.advance(waitMs);
      await h.flush();
    }
    expect(h.client.connection.state).toBe("open");
    expect(h.server.sockets).toHaveLength(2);
    expect(h.ticketCalls()).toBe(2);
  });

  it("reconnects after a network drop (1006) and any other code", async () => {
    for (const code of [1000, 1001, 1006, 1011]) {
      const h = harness();
      await open(h);
      h.server.dropAll(code);
      await h.flush();
      expect(h.client.connection).toMatchObject({ state: "backoff", lastCode: code });
      await h.clock.advance(250);
      await h.flush();
      expect(h.client.connection.state).toBe("open");
    }
  });

  it("stops when a fresh ticket is refused too", async () => {
    const h = harness();
    h.server.refuseConnections.push(4003, 4003);
    h.client.start();
    await h.flush();
    expect(h.client.connection).toMatchObject({ state: "closed", reason: "ticket_refused" });
    expect(h.ticketCalls()).toBe(2);
  });

  it("stops when the session is purged, and when a newer socket replaces it", async () => {
    const h = harness();
    await open(h);
    h.server.purge();
    await h.flush();
    expect(h.client.connection).toMatchObject({ state: "closed", reason: "session_ended" });

    const other = harness();
    await open(other);
    const second = createSessionClient({
      sessionId: SESSION,
      url: other.server.edgeUrl,
      socket: other.server.factory,
      clock: other.clock,
      page: other.page,
      getTicket: async () => other.server.issueTicket(),
    });
    second.start();
    await other.flush();
    expect(second.connection.state).toBe("open");
    expect(other.client.connection).toMatchObject({ state: "closed", reason: "replaced" });
    second.stop();
  });

  it("stops for ticket route refusals reconnecting can't fix, and waits out a 429", async () => {
    for (const [code, reason] of [
      ["signed_out", "signed_out"],
      ["not_found", "not_found"],
      ["forbidden", "forbidden"],
      ["session_ended", "session_ended"],
    ] as const) {
      const h = harness({
        client: {
          getTicket: async () => {
            throw new SessionTicketError(code);
          },
        },
      });
      h.client.start();
      await h.flush();
      expect(h.client.connection).toMatchObject({ state: "closed", reason });
    }
    let calls = 0;
    const h = harness({
      client: {
        getTicket: async () => {
          calls += 1;
          if (calls === 1) throw new SessionTicketError("rate_limited", { retryAfterMs: 30_000 });
          return h.server.issueTicket();
        },
      },
    });
    h.client.start();
    await h.flush();
    expect(h.client.connection.state).toBe("backoff");
    expect((h.client.connection.retryAt ?? 0) - h.clock.now()).toBe(30_000);
    await h.clock.advance(30_000);
    await h.flush();
    expect(h.client.connection.state).toBe("open");
  });

  it("backs off with jitter that grows, and resets once a socket opens", async () => {
    const delays: number[] = [];
    const h = harness({
      client: {
        random: () => 0.999,
        getTicket: async () => {
          throw new Error("offline-ish");
        },
      },
    });
    h.client.start();
    for (let i = 0; i < 6; i++) {
      await h.flush();
      const waitMs = (h.client.connection.retryAt ?? 0) - h.clock.now();
      delays.push(waitMs);
      await h.clock.advance(waitMs);
    }
    expect(delays).toEqual([500, 999, 1998, 3996, 7992, 14985]);
  });
});

describe("SessionClient: heartbeat", () => {
  it("pings while idle and stays open while pongs come back", async () => {
    const h = harness();
    await open(h);
    await h.clock.advance(20_000);
    expect(h.server.sockets[0]?.received.filter((frame) => frame === "ping")).toHaveLength(1);
    await h.clock.advance(30_000);
    await h.flush();
    expect(h.client.connection.state).toBe("open");
    expect(h.server.sockets).toHaveLength(1);
  });

  it("treats an unanswered ping as a dead socket, and reconnects", async () => {
    const h = harness();
    await open(h);
    h.server.respondToPings = false;
    await h.clock.advance(20_000);
    await h.clock.advance(9_999);
    expect(h.client.connection.state).toBe("open");
    await h.clock.advance(1);
    expect(h.client.connection.state).toBe("backoff");
    expect(h.server.sockets[0]?.clientClose).toEqual({ code: 1000, reason: "heartbeat" });
    await h.clock.advance(250);
    await h.flush();
    expect(h.client.connection.state).toBe("open");
    expect(h.server.sockets).toHaveLength(2);
  });

  it("treats a welcome that never comes as a dead socket, and reconnects", async () => {
    const h = harness();
    h.server.answerHellos = false;
    h.client.start();
    await h.flush();
    expect(h.client.connection.state).toBe("resuming");
    await h.clock.advance(10_000);
    expect(h.client.connection.state).toBe("backoff");
    h.server.answerHellos = true;
    await h.clock.advance(250);
    await h.flush();
    expect(h.client.connection.state).toBe("open");
    expect(h.server.sockets).toHaveLength(2);
  });
});

describe("SessionClient: the turn key", () => {
  it("never reaches the store or the log, rides only on turn_end, and is dropped once acked", async () => {
    const h = harness();
    await started(h);
    h.server.holdTurns = true;
    const turnId = newTurnId();
    h.client.sendUtterance(turnId, utterance());
    const turnEndId = h.client.sendTurnEnd({
      turnId,
      trigger: "ptt_release",
      llm: { provider: "anthropic", model: "claude-haiku-5-5" },
      key: KEY,
    });
    await h.flush();
    expect(JSON.stringify(h.client.pendingMessages())).not.toContain(KEY);
    expect(h.client.pendingMessages()).toEqual([
      {
        t: "turn_end",
        msgId: turnEndId,
        turnId,
        trigger: "ptt_release",
        llm: { provider: "anthropic", model: "claude-haiku-5-5" },
      },
    ]);
    // A drop before the ack: the key is still held, so the resend carries it.
    h.server.dropAll(1006);
    await h.flush();
    await h.clock.advance(250);
    await h.flush();
    expect(h.server.turnKeys).toEqual([KEY, KEY]);
    h.server.completeTurns();
    await h.flush();
    expect(h.client.store.getState().pending).toBe(0);
    // After the ack nothing holds it: another reconnect resends nothing.
    h.server.dropAll(1006);
    await h.flush();
    await h.clock.advance(250);
    await h.flush();
    expect(h.server.turnKeys).toEqual([KEY, KEY]);
    // On the wire only in turn_end frames; nowhere in any store state or log line.
    const frames = h.server.sockets.flatMap((socket) => socket.received).map(String);
    const carrying = frames.filter((frame) => frame.includes(KEY));
    expect(carrying).toHaveLength(2);
    for (const frame of carrying)
      expect(JSON.parse(frame)).toMatchObject({ t: "turn_end", key: KEY });
    expect(h.snapshots.length).toBeGreaterThan(5);
    for (const snapshot of h.snapshots) expect(snapshot).not.toContain(KEY);
    for (const line of h.logs) expect(line).not.toContain(KEY);
  });

  it("sends the recap's key only on end.recap.key, resends it until the ack, then drops it (Phase 5 WP10)", async () => {
    const h = harness();
    await started(h);
    h.client.sendUtterance(newTurnId(), utterance("Just met Dana. She wants a quote."));
    await h.flush();
    const ended = h.client.end("2026-11-19T12:05:00.000Z", {
      llm: { provider: "groq", model: "openai/gpt-oss-20b" },
      key: KEY,
      lens: "meddic",
    });
    expect(JSON.stringify(h.client.pendingMessages())).not.toContain(KEY);
    await h.flush();
    await ended;
    expect(h.server.recapKeys).toEqual([KEY]);
    expect(h.client.pendingMessages()).toEqual([]);
    // The recap the server wrote after the end reaches the store, without the key.
    await h.flush();
    const recap = h.client.store.getState().projections.session?.recap;
    expect(recap).toMatchObject({ outcome: "created", llm: { provider: "groq" } });
    // After the ack nothing holds it: a reconnect resends nothing with it.
    h.server.dropAll(1006);
    await h.flush();
    await h.clock.advance(250);
    await h.flush();
    expect(h.server.recapKeys).toEqual([KEY]);
    const frames = h.server.sockets.flatMap((socket) => socket.received).map(String);
    const carrying = frames.filter((frame) => frame.includes(KEY));
    expect(carrying).toHaveLength(1);
    expect(JSON.parse(carrying[0] as string)).toMatchObject({ t: "end", recap: { key: KEY } });
    for (const snapshot of h.snapshots) expect(snapshot).not.toContain(KEY);
    for (const line of h.logs) expect(line).not.toContain(KEY);
  });

  it("refuses here an end whose recap carries its key anywhere else", async () => {
    const h = harness();
    await started(h);
    const ended = h.client.end("2026-11-19T12:05:00.000Z", {
      llm: { provider: "anthropic", model: KEY },
      key: "0123456789abcdef0123456789abcdef",
    });
    await expect(ended).rejects.toMatchObject({ code: "bad_message" });
    expect(h.server.recapKeys).toEqual([]);
    for (const snapshot of h.snapshots) expect(snapshot).not.toContain(KEY);
  });

  it("drops held keys when the client stops before the ack", async () => {
    const h = harness();
    await started(h);
    h.server.holdTurns = true;
    h.client.sendTurnEnd({
      turnId: newTurnId(),
      trigger: "manual",
      llm: { provider: "groq", model: "openai/gpt-oss-20b" },
      key: KEY,
    });
    const ended = h.client.end("2026-11-19T12:05:00.000Z");
    await h.flush();
    h.client.stop();
    await expect(ended).rejects.toBeInstanceOf(SessionClosedError);
    expect(h.client.pendingMessages()).toEqual([]);
    expect(h.client.store.getState().pending).toBe(0);
    expect(h.client.sendUsage({ provider: "a", model: "b", audioMs: 1, socketMs: 1 })).toBeNull();
  });

  it("keeps keys apart inside the outbox, and forgets them on removal", () => {
    const outbox = new Outbox();
    outbox.add({
      t: "turn_end",
      msgId: "00000000-0000-7000-8000-000000000001",
      turnId: "00000000-0000-7000-8000-000000000002",
      trigger: "manual",
      llm: { provider: "groq", model: "openai/gpt-oss-20b" },
      key: KEY,
    });
    expect(JSON.stringify(outbox.items())).not.toContain(KEY);
    expect(JSON.parse(outbox.frame("00000000-0000-7000-8000-000000000001")).key).toBe(KEY);
    expect(outbox.heldKeys).toBe(1);
    outbox.remove("00000000-0000-7000-8000-000000000001");
    expect(outbox.heldKeys).toBe(0);
  });

  it("keeps the recap's key apart inside the outbox too, and splices it back only into its frame (Phase 5 WP10)", () => {
    const outbox = new Outbox();
    const msgId = "00000000-0000-7000-8000-000000000003";
    outbox.add({
      t: "end",
      msgId,
      endedAt: "2026-11-19T12:05:00.000Z",
      recap: { llm: { provider: "anthropic", model: "claude-haiku-5-5" }, key: KEY, lens: "bant" },
    });
    expect(JSON.stringify(outbox.items())).not.toContain(KEY);
    expect(outbox.items()).toEqual([
      {
        t: "end",
        msgId,
        endedAt: "2026-11-19T12:05:00.000Z",
        recap: { llm: { provider: "anthropic", model: "claude-haiku-5-5" }, lens: "bant" },
      },
    ]);
    const frame = JSON.parse(outbox.frame(msgId));
    expect(frame.recap.key).toBe(KEY);
    expect(frame.key).toBeUndefined();
    expect(outbox.heldKeys).toBe(1);
    outbox.remove(msgId);
    expect(outbox.heldKeys).toBe(0);
    // An end with no recap holds no key.
    outbox.add({ t: "end", msgId, endedAt: "2026-11-19T12:05:00.000Z" });
    expect(outbox.heldKeys).toBe(0);
  });

  it("sends an utterance too big for one frame as several, in order, refusing none", async () => {
    const h = harness();
    await started(h);
    const words = Array.from({ length: 1_500 }, (_, i) => ({
      w: "a",
      startMs: i * 100,
      endMs: i * 100 + 80,
      confidence: 0.9,
    }));
    const big: UtteranceFinalV2 = {
      ...utterance(words.map((word) => word.w).join(" ")),
      words,
      startMs: 0,
      endMs: 149_980,
    };
    const turnId = newTurnId();
    expect(h.client.sendUtterance(turnId, big)).not.toBeNull();
    await h.flush();
    const sent = h.server.received.filter((m) => m.t === "utterance");
    expect(sent.length).toBeGreaterThan(1);
    for (const message of sent) {
      expect(new TextEncoder().encode(JSON.stringify(message)).byteLength).toBeLessThanOrEqual(
        MAX_MESSAGE_BYTES,
      );
    }
    expect(
      sent.flatMap((m) => (m.t === "utterance" ? (m.utterance.words ?? []) : [])),
    ).toHaveLength(1_500);
    expect(h.client.store.getState().issues).toEqual([]);
  });

  it("refuses here a message SessionDO would refuse, such as a key-shaped utterance", async () => {
    const h = harness();
    await started(h);
    const id = h.client.sendUtterance(newTurnId(), utterance(`my key is ${KEY}`));
    expect(id).toBeNull();
    await h.flush();
    expect(h.server.received.some((m) => m.t === "utterance")).toBe(false);
    expect(h.client.store.getState().issues.at(-1)).toMatchObject({ code: "bad_message" });
    for (const snapshot of h.snapshots) expect(snapshot).not.toContain(KEY);
  });
});

describe("SessionClient: answers and errors", () => {
  it("shows the server working on a turn, then the turn's outcome", async () => {
    const h = harness();
    await started(h);
    h.server.holdTurns = true;
    const turnId = newTurnId();
    h.client.sendUtterance(turnId, utterance());
    h.client.sendTurnEnd({
      turnId,
      trigger: "ptt_release",
      llm: { provider: "anthropic", model: "claude-haiku-5-5" },
      key: KEY,
    });
    await h.flush();
    expect(h.client.store.getState().working[turnId]).toMatchObject({ state: "thinking" });
    h.server.completeTurns();
    await h.flush();
    expect(h.client.store.getState().working).toEqual({});
  });

  it("resends after SessionDO refuses a message for rate, unparsed", async () => {
    const h = harness();
    await started(h);
    h.server.refuseNext = 1;
    const id = h.client.sendUsage({
      provider: "assemblyai",
      model: "universal-streaming-english",
      audioMs: 100,
      socketMs: 200,
    });
    await h.flush();
    expect(h.client.store.getState().pending).toBe(1);
    expect(h.client.store.getState().issues.at(-1)).toMatchObject({ code: "rate_limited" });
    await h.clock.advance(1_000);
    await h.flush();
    expect(h.client.store.getState().pending).toBe(0);
    expect(h.server.commits.get(id ?? "")).toBe(1);
  });

  it("sends the open account and each record's parent in start, and nothing for no account", async () => {
    const entities = [
      { id: "co_1", kind: "company" as const, name: "Acme Dynamics", aliases: ["Acme"] },
      { id: "ct_1", kind: "contact" as const, name: "Dana Lee", aliases: [], parentId: "co_1" },
    ];
    const open_ = harness();
    await open(open_);
    open_.client.sendStart({
      providers: PROVIDERS,
      startedAt: "2026-11-19T12:00:00.000Z",
      entities,
      focusEntityId: "co_1",
    });
    await open_.flush();
    expect(open_.server.received.find((message) => message.t === "start")).toMatchObject({
      entities,
      focusEntityId: "co_1",
    });
    expect(open_.server.log.map((event) => event.type)).toEqual(["session.started"]);

    const none = harness();
    await open(none);
    none.client.sendStart({
      providers: PROVIDERS,
      startedAt: "2026-11-19T12:00:00.000Z",
      entities,
      focusEntityId: null,
    });
    await none.flush();
    expect(none.server.received.find((message) => message.t === "start")).not.toHaveProperty(
      "focusEntityId",
    );
  });

  it("sends the session's signed approval policy in start, unchanged, and none when there's none (Phase 5 WP11)", async () => {
    const policy = {
      id: "01a1c6f2-7d10-7a3b-9c4d-5e6f7a8b9c0d",
      version: 2,
      rules: {
        v: 1 as const,
        autoApprove: [{ id: "notes", type: "note" as const, alwaysReview: [] }],
      },
      // Base64url of 32 bytes; the in-memory SessionDO doesn't check it, the real one does.
      sig: "Zm9yLXRlc3RzLW9ubHktbm90LWEtcmVhbC1zaWduYXQ",
    };
    const signed = harness();
    await open(signed);
    signed.client.sendStart({
      providers: PROVIDERS,
      startedAt: "2026-11-19T12:00:00.000Z",
      entities: [],
      policy,
    });
    await signed.flush();
    expect(signed.server.received.find((message) => message.t === "start")).toMatchObject({
      policy,
    });

    const none = harness();
    await open(none);
    none.client.sendStart({
      providers: PROVIDERS,
      startedAt: "2026-11-19T12:00:00.000Z",
      entities: [],
      policy: null,
    });
    await none.flush();
    expect(none.server.received.find((message) => message.t === "start")).not.toHaveProperty(
      "policy",
    );
  });

  it("drops a message refused for good, and retries one refused for now", async () => {
    const h = harness();
    await open(h);
    // Before `start`: refused for now, so it waits and goes again.
    const turnId = newTurnId();
    const early = h.client.sendUtterance(turnId, utterance());
    await h.flush();
    expect(h.client.store.getState().pending).toBe(1);
    h.client.sendStart({
      providers: PROVIDERS,
      startedAt: "2026-11-19T12:00:00.000Z",
      entities: [],
    });
    await h.flush();
    await h.clock.advance(1_000);
    await h.flush();
    expect(h.client.store.getState().pending).toBe(0);
    expect(h.server.commits.get(early ?? "")).toBe(1);
    expect(h.server.log.map((event) => event.type)).toEqual(["session.started", "utterance.final"]);
    // After `end`: refused for good.
    await h.client.end("2026-11-19T12:05:00.000Z");
    const late = h.client.sendUtterance(turnId, utterance());
    const refused = h.client.acked(late ?? "");
    await h.flush();
    await expect(refused).rejects.toBeInstanceOf(MessageRefusedError);
    expect(h.client.store.getState().pending).toBe(0);
    expect(h.client.store.getState().issues.at(-1)).toMatchObject({
      source: "server",
      code: "already_ended",
      retryable: false,
    });
  });

  it("paces its messages so SessionDO's token bucket never refuses one, and delivers them all", async () => {
    let clock: ManualClock | undefined;
    const h = harness({ server: { rateClock: () => clock?.now() ?? 0 } });
    clock = h.clock;
    await started(h);
    for (let i = 0; i < 60; i++) {
      h.client.sendUsage({
        provider: "assemblyai",
        model: "universal-streaming-english",
        audioMs: i,
        socketMs: i,
      });
    }
    await h.flush();
    // The client's own burst went at once; the rest wait for its budget to refill.
    expect(h.server.received.filter((m) => m.t === "usage").length).toBeLessThan(20);
    for (let i = 0; i < 80; i++) await h.clock.advance(100);
    await h.flush();
    expect(h.client.store.getState().pending).toBe(0);
    expect(h.server.commits.size).toBe(61);
    expect(h.server.rateRefusals).toBe(0);
    // Order held: the usage events are in the order they were sent.
    const audio = h.server.log
      .filter((e) => e.type === "usage.recorded")
      .map((e) => e.payload.audioMs);
    expect(audio).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });

  it("would be refused by that bucket if it sent its burst unpaced (the check's control)", async () => {
    let clock: ManualClock | undefined;
    const h = harness({
      server: { rateClock: () => clock?.now() ?? 0 },
      client: { sendBudget: { burst: 100, perSecond: 100 } },
    });
    clock = h.clock;
    await started(h);
    for (let i = 0; i < 30; i++) {
      h.client.sendUsage({
        provider: "assemblyai",
        model: "universal-streaming-english",
        audioMs: i,
        socketMs: i,
      });
    }
    await h.flush();
    expect(h.server.rateRefusals).toBeGreaterThan(0);
  });

  it("acks cumulatively, once a burst of events has landed", async () => {
    const h = harness({ sessionId: demoSessionId, seed: demo });
    h.client.start();
    await h.flush();
    await h.clock.advance(250);
    await h.flush();
    const acks = h.server.received.filter((m) => m.t === "ack");
    expect(acks).toEqual([{ t: "ack", seq: demo.length - 1 }]);
  });
});

describe("SessionClient: the page", () => {
  it("waits offline instead of retrying, and reconnects as soon as it's back", async () => {
    const h = harness();
    await open(h);
    h.server.dropAll(1006);
    await h.flush();
    h.page.emit("offline");
    expect(h.client.connection).toMatchObject({ state: "offline", online: false });
    await h.clock.advance(120_000);
    await h.flush();
    expect(h.server.sockets).toHaveLength(1);
    h.page.emit("online");
    await h.flush();
    expect(h.client.connection.state).toBe("open");
  });

  it("on iOS, stops capture, flushes, closes when hidden, and resumes when visible", async () => {
    const page = new FakePageLifecycle({ suspendsWhenHidden: true });
    const turnId = newTurnId();
    let h: Harness | undefined;
    const onSuspend = vi.fn(async () => {
      // The engine stopping emits the turn's last final and its end.
      h?.client.sendUtterance(turnId, utterance());
      h?.client.sendTurnEnd({
        turnId,
        trigger: "manual",
        llm: { provider: "anthropic", model: "claude-haiku-5-5" },
        key: KEY,
      });
    });
    h = harness({ page, client: { onSuspend } });
    await started(h);
    page.emit("hidden");
    await h.flush();
    expect(onSuspend).toHaveBeenCalledTimes(1);
    expect(h.client.connection.state).toBe("suspended");
    expect(h.server.sockets[0]?.clientClose).toEqual({ code: 1000, reason: "hidden" });
    // The flush made it out before the close.
    expect(h.server.log.map((event) => event.type)).toContain("turn.completed");
    await h.clock.advance(60_000);
    expect(h.server.sockets).toHaveLength(1);
    page.emit("visible");
    await h.flush();
    expect(h.client.connection.state).toBe("open");
    expect(h.client.store.getState().pending).toBe(0);
    expect(h.client.store.getState().projections.proposals).toHaveLength(1);
  });

  it("ignores hiding on platforms that keep their sockets", async () => {
    const h = harness();
    await open(h);
    h.page.emit("hidden");
    await h.flush();
    expect(h.client.connection.state).toBe("open");
  });

  it("starts suspended on a hidden iOS page, and connects once it's shown", async () => {
    const page = new FakePageLifecycle({ suspendsWhenHidden: true, hidden: true });
    const h = harness({ page });
    h.client.start();
    await h.flush();
    expect(h.client.connection.state).toBe("suspended");
    expect(h.server.sockets).toHaveLength(0);
    page.emit("visible");
    await h.flush();
    expect(h.client.connection.state).toBe("open");
    h.client.stop();
    expect(page.listeners).toBe(0);
  });
});

describe("SessionClient: one session at a time (v1's bug)", () => {
  it("starts a second session with none of the first one's proposals, turns, or costs", async () => {
    const first = harness();
    await started(first);
    const turnId = newTurnId();
    first.client.sendUtterance(turnId, utterance());
    first.client.sendTurnEnd({
      turnId,
      trigger: "ptt_release",
      llm: { provider: "anthropic", model: "claude-haiku-5-5" },
      key: KEY,
    });
    first.client.sendUsage({
      provider: "assemblyai",
      model: "universal-streaming-english",
      audioMs: 1_000,
      socketMs: 2_000,
    });
    await first.client.end("2026-11-19T12:05:00.000Z");
    expect(first.client.store.getState().projections.proposals).toHaveLength(1);
    expect(first.client.store.getState().meter.records).toBe(1);
    first.client.stop();

    const secondId = "0000000a-0000-7000-8000-00000000b0b0";
    const second = harness({ sessionId: secondId });
    await started(second);
    const state = second.client.store.getState();
    expect(state.projections.proposals).toEqual([]);
    expect(state.turns).toEqual([]);
    expect(state.meter.records).toBe(0);
    expect(state.working).toEqual({});
    expect(state.events.every((event) => event.sessionId === secondId)).toBe(true);
    // A store can't be carried into another session's client.
    expect(() =>
      createSessionClient({
        sessionId: secondId,
        url: second.server.edgeUrl,
        getTicket: async () => second.server.issueTicket(),
        store: first.client.store,
      }),
    ).toThrow(/another session/);
    // And a stopped client's socket can't reach anything: nothing opens after stop.
    await first.clock.advance(60_000);
    await first.flush();
    expect(first.server.sockets).toHaveLength(1);
  });

  it("keeps a late frame from a replaced socket out of the store", async () => {
    const h = harness();
    await started(h);
    const old = h.server.current;
    h.server.dropAll(1006);
    await h.flush();
    await h.clock.advance(250);
    await h.flush();
    // The old socket's client side is closed: nothing it might still deliver is read.
    const before = h.client.store.getState();
    old?.socket.client.onmessage?.({
      data: JSON.stringify({ t: "working", turnId: newTurnId(), state: "thinking" }),
    });
    await h.flush();
    expect(h.client.store.getState()).toBe(before);
  });
});

describe("SessionStore sharing", () => {
  it("lets the screen subscribe before the client connects", async () => {
    const store = new SessionStore(SESSION);
    const states: string[] = [];
    store.subscribe(() => states.push(store.getState().connection.state));
    const h = harness({ client: { store } });
    await open(h);
    expect(h.client.store).toBe(store);
    expect(states).toContain("connecting");
    expect(states.at(-1)).toBe("open");
  });
});
