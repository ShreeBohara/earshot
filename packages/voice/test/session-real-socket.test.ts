// SessionClient over a real WebSocket: Node's global WebSocket (the browser's client API) through
// `createBrowserSocket`, against a `ws` server on loopback that plays the edge and SessionDO. It
// checks what the in-memory fake can't: the ticket really travels in `Sec-WebSocket-Protocol`
// and never in the URL, the server's subprotocol choice, real close codes, and text frames.
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket as ServerSocket, WebSocketServer } from "ws";
import { createSessionClient } from "../src/session/client";
import { FakePageLifecycle } from "../src/testing/fake-page";

const SESSION = "0000000a-0000-7000-8000-0000000ab1e5";
const TICKET = "eyJ2IjoxLCJzaWQiOiJ4In0.c2lnbmF0dXJlLWJ5dGVz";

let server: WebSocketServer | undefined;

afterEach(async () => {
  for (const client of server?.clients ?? []) client.terminate();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const until = async (check: () => boolean, ms = 3_000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("SessionClient over a real WebSocket", () => {
  it("offers the ticket as a subprotocol, resumes, acks, pings, and stops on 4006", async () => {
    const seen: { request?: IncomingMessage; protocol?: string; frames: string[] } = { frames: [] };
    let socket: ServerSocket | undefined;
    server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      handleProtocols: (protocols) => (protocols.has("earshot.v1") ? "earshot.v1" : false),
    });
    server.on("connection", (ws, request) => {
      socket = ws;
      seen.request = request;
      seen.protocol = ws.protocol;
      ws.on("message", (data) => {
        const text = data.toString();
        seen.frames.push(text);
        if (text === "ping") return ws.send("pong");
        const message = JSON.parse(text) as { t: string; lastSeq?: number };
        if (message.t === "hello") {
          ws.send(JSON.stringify({ t: "welcome", sessionId: SESSION, lastSeq: 0, protocol: 1 }));
          ws.send(
            JSON.stringify({
              t: "event",
              event: {
                id: "0000000e-0000-7000-8000-000000000000",
                sessionId: SESSION,
                seq: 0,
                type: "session.started",
                schemaVersion: 1,
                ts: "2026-11-19T12:00:00.040Z",
                payload: {
                  mode: "debrief",
                  engine: "cascaded",
                  providers: {},
                  startedAt: "2026-11-19T12:00:00.000Z",
                },
              },
            }),
          );
        }
      });
    });
    await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const url = `ws://127.0.0.1:${port}/v1/sessions/${SESSION}/ws`;

    const client = createSessionClient({
      sessionId: SESSION,
      url,
      getTicket: async () => ({ ticket: TICKET }),
      page: new FakePageLifecycle(),
      ackDelayMs: 10,
      heartbeatMs: 40,
    });
    client.start();
    await until(() => client.store.getState().lastSeq === 0);
    expect(seen.request?.headers["sec-websocket-protocol"]).toBe(
      `earshot.v1, earshot.ticket.${TICKET}`,
    );
    expect(seen.request?.url).toBe(`/v1/sessions/${SESSION}/ws`);
    expect(seen.protocol).toBe("earshot.v1");
    expect(client.connection.state).toBe("open");
    expect(client.store.getState().projections.session?.status).toBe("active");

    await until(() => seen.frames.includes("ping") && seen.frames.some((f) => f.includes('"ack"')));
    expect(seen.frames[0]).toBe(JSON.stringify({ t: "hello", protocol: 1, lastSeq: -1 }));
    expect(seen.frames).toContain(JSON.stringify({ t: "ack", seq: 0 }));

    socket?.close(4006, "session ended");
    await until(() => client.connection.state === "closed");
    expect(client.connection).toMatchObject({ reason: "session_ended", lastCode: 4006 });
    // Nothing reconnects after a final close.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.clients.size).toBe(0);
  });
});
