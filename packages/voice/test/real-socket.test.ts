// The adapters over a real WebSocket: Node's global WebSocket (the same client API as a
// browser's) through `createBrowserSocket`, against a local `ws` server on loopback. This checks
// what an in-memory fake can't: the subprotocol handshake, query-string encoding as an HTTP server
// parses it, and binary frames on the wire. No provider is contacted.
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket as ServerSocket, WebSocketServer } from "ws";
import type { SttEvent } from "../src/stt/adapter";
import { createAssemblyAiAdapter } from "../src/stt/assemblyai";
import { createDeepgramFluxAdapter } from "../src/stt/deepgram-flux";
import { createDeepgramNova3Adapter } from "../src/stt/deepgram-nova3";
import { createBrowserSocket } from "../src/stt/socket";
import { assemblyAi, flux, nova3 } from "./fixtures/providers";

interface Accepted {
  readonly socket: ServerSocket;
  readonly request: IncomingMessage;
  readonly messages: (string | Buffer)[];
}

let server: WebSocketServer | undefined;

afterEach(async () => {
  for (const client of server?.clients ?? []) client.terminate();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A loopback server that chooses "bearer" when offered, and hands over each connection. */
async function listen(): Promise<{ base: string; next: () => Promise<Accepted> }> {
  const queue: Accepted[] = [];
  const waiting: ((accepted: Accepted) => void)[] = [];
  server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    handleProtocols: (protocols) => (protocols.has("bearer") ? "bearer" : false),
  });
  server.on("connection", (socket, request) => {
    const accepted: Accepted = { socket, request, messages: [] };
    socket.on("message", (data, isBinary) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
      accepted.messages.push(isBinary ? buffer : buffer.toString("utf8"));
    });
    const waiter = waiting.shift();
    if (waiter) waiter(accepted);
    else queue.push(accepted);
  });
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `ws://127.0.0.1:${port}`,
    next: () =>
      new Promise((resolve) => {
        const ready = queue.shift();
        if (ready) resolve(ready);
        else waiting.push(resolve);
      }),
  };
}

const until = async (check: () => boolean, ms = 2_000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("over a real WebSocket", () => {
  it("AssemblyAI: token and JSON keyterms in the query, binary PCM, a final, and provider usage", async () => {
    const { base, next } = await listen();
    const connecting = createAssemblyAiAdapter({ socket: createBrowserSocket }).connect({
      credential: {
        provider: "assemblyai",
        credential: "tok-abc.123",
        expiresAt: "2026-11-15T12:01:00Z",
        url: base,
      },
      keyterms: ["Acme Corp", "Zoë's Café & Bar"],
      baseOffsetMs: 1_000,
    });
    const peer = await next();
    const connection = await connecting;
    const events: SttEvent[] = [];
    connection.on((event) => events.push(event));

    const url = new URL(peer.request.url ?? "", base);
    expect(url.pathname).toBe("/v3/ws");
    expect(url.searchParams.get("token")).toBe("tok-abc.123");
    expect(JSON.parse(url.searchParams.get("keyterms_prompt") ?? "null")).toEqual([
      "Acme Corp",
      "Zoë's Café & Bar",
    ]);
    expect(peer.request.headers["sec-websocket-protocol"]).toBeUndefined();

    const pcm = Int16Array.from({ length: 1_024 }, (_, i) => ((i * 37) % 30_000) - 15_000);
    connection.send(pcm);
    await until(() => peer.messages.length === 1);
    const bytes = peer.messages[0] as Buffer;
    expect(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)).toEqual(pcm);

    peer.socket.send(JSON.stringify(assemblyAi.endOfTurn));
    await until(() => events.some((event) => event.type === "end_of_turn"));
    const final = events.find((event) => event.type === "final");
    expect(final?.type === "final" && final.utterance.startMs).toBe(2_440);

    peer.socket.on("message", (data, isBinary) => {
      if (!isBinary && JSON.parse(String(data)).type === "Terminate") {
        peer.socket.send(JSON.stringify(assemblyAi.termination));
        peer.socket.close(1000);
      }
    });
    const usage = await connection.close();
    expect(usage).toMatchObject({ audioMs: 12_480, socketMs: 15_020, source: "provider" });
  });

  it("Deepgram Nova-3: the JWT rides as [bearer, jwt], the server chooses bearer, keyterms repeat", async () => {
    const { base, next } = await listen();
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZWFsIn0.c2lnbmF0dXJlLXJlYWw";
    const connecting = createDeepgramNova3Adapter({ socket: createBrowserSocket }).connect({
      credential: {
        provider: "deepgram",
        credential: jwt,
        expiresAt: "2026-11-15T12:00:30Z",
        url: base,
      },
      keyterms: ["Acme Corp", "Initech"],
      baseOffsetMs: 0,
    });
    const peer = await next();
    const connection = await connecting;
    const events: SttEvent[] = [];
    connection.on((event) => events.push(event));

    expect(peer.request.headers["sec-websocket-protocol"]).toBe(`bearer, ${jwt}`);
    expect(peer.socket.protocol).toBe("bearer");
    const url = new URL(peer.request.url ?? "", base);
    expect(url.pathname).toBe("/v1/listen");
    expect(url.searchParams.getAll("keyterm")).toEqual(["Acme Corp", "Initech"]);
    expect(url.toString()).not.toContain(jwt);

    connection.finalize();
    await until(() => peer.messages.length === 1);
    expect(JSON.parse(String(peer.messages[0]))).toEqual({ type: "Finalize" });
    peer.socket.send(JSON.stringify(nova3.segment1));
    peer.socket.send(JSON.stringify(nova3.finalizeAnswer));
    await until(() => events.some((event) => event.type === "end_of_turn"));
    expect(events.filter((event) => event.type === "final")).toHaveLength(1);
    peer.socket.close(1000);
    await until(() => events.some((event) => event.type === "closed"));
  });

  it("Deepgram Flux: the same credential on /v2/listen, a Configure round trip, and a drop", async () => {
    const { base, next } = await listen();
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmbHV4In0.c2lnLWZsdXgtcmVhbA";
    const connecting = createDeepgramFluxAdapter({ socket: createBrowserSocket }).connect({
      credential: {
        provider: "deepgram",
        credential: jwt,
        expiresAt: "2026-11-15T12:00:30Z",
        url: base,
      },
      keyterms: [],
      baseOffsetMs: 0,
    });
    const peer = await next();
    const connection = await connecting;
    const events: SttEvent[] = [];
    connection.on((event) => events.push(event));
    expect(new URL(peer.request.url ?? "", base).pathname).toBe("/v2/listen");

    peer.socket.on("message", (data, isBinary) => {
      if (!isBinary && JSON.parse(String(data)).type === "Configure") {
        peer.socket.send(JSON.stringify(flux.configureSuccess));
      }
    });
    await connection.updateKeyterms(["Globex"]);

    peer.socket.terminate(); // no close frame: what a network drop looks like
    await until(() => events.some((event) => event.type === "closed"));
    expect(events.find((event) => event.type === "error")).toMatchObject({
      code: "connection_lost",
      fatal: true,
    });
    expect(events.find((event) => event.type === "closed")).toMatchObject({ expected: false });
  });
});
