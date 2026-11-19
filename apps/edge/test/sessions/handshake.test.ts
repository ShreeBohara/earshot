// The handshake (spec §4.3, WP6 tests "Tickets"): the edge route's checks, then SessionDO's.
import { DEV_SESSION_TICKET_SECRET, SESSION_CLOSE_CODES, SESSION_SUBPROTOCOL } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { connect, newSession, ORIGIN, open, sessionStub, ticketFor } from "./helpers";

const codeOf = (name: keyof typeof SESSION_CLOSE_CODES) => SESSION_CLOSE_CODES[name].code;

async function closeCode(handshake: Awaited<ReturnType<typeof connect>>) {
  expect(handshake.status).toBe(101);
  if (!handshake.socket) throw new Error("no socket");
  return (await handshake.socket.closed).code;
}

describe("the edge route", () => {
  it("accepts a valid ticket and answers with earshot.v1 alone, never echoing the ticket", async () => {
    const ids = newSession();
    const ticket = await ticketFor(ids);
    const handshake = await connect(ids.sid, { ticket });
    expect(handshake.status).toBe(101);
    expect(handshake.protocol).toBe(SESSION_SUBPROTOCOL);
    handshake.socket?.send({ t: "hello", protocol: 1, lastSeq: -1 });
    const welcome = await handshake.socket?.waitFor((m) => m.t === "welcome");
    expect(welcome).toEqual({ t: "welcome", sessionId: ids.sid, lastSeq: -1, protocol: 1 });
    handshake.socket?.close();
  });

  it("answers anything but a WebSocket upgrade with 426", async () => {
    const { exports } = await import("cloudflare:workers");
    const response = await exports.default.fetch(
      `https://edge.test/v1/sessions/${newSession().sid}/ws`,
      { headers: { Origin: ORIGIN } },
    );
    expect(response.status).toBe(426);
  });

  it("refuses a foreign or missing Origin with 403, before any socket exists", async () => {
    const ids = newSession();
    const ticket = await ticketFor(ids);
    for (const origin of ["https://evil.example", "http://localhost:3001", "null", null]) {
      const handshake = await connect(ids.sid, { ticket, origin });
      expect(handshake.status).toBe(403);
      expect(handshake.socket).toBeUndefined();
    }
  });

  it("closes with unsupported_protocol when earshot.v1 isn't offered", async () => {
    const ids = newSession();
    const ticket = await ticketFor(ids);
    const handshake = await connect(ids.sid, { protocols: [`earshot.ticket.${ticket}`] });
    expect(await closeCode(handshake)).toBe(codeOf("unsupported_protocol"));
    expect(handshake.protocol).toBeNull();
  });

  it("closes with ticket_refused for a missing, forged, foreign, expired, or other-session ticket", async () => {
    const ids = newSession();
    const valid = await ticketFor(ids);
    const [payload = "", signature = ""] = valid.split(".");
    const flipped = `${signature.slice(0, -2)}${signature.endsWith("AA") ? "BA" : "AA"}`;
    const cases = {
      missing: undefined,
      forged: `${payload}.${flipped}`,
      foreignSecret: await ticketFor(ids, { secret: `${DEV_SESSION_TICKET_SECRET}-another` }),
      expired: await ticketFor(ids, { now: new Date(Date.now() - 2 * 60_000) }),
      otherSession: await ticketFor({ ...ids, sid: newSession().sid }),
      garbage: "not-a-ticket",
    };
    for (const [name, ticket] of Object.entries(cases)) {
      const code = await closeCode(await connect(ids.sid, ticket ? { ticket } : {}));
      expect({ name, code }).toEqual({ name, code: codeOf("ticket_refused") });
    }
    // Two tickets at once are refused too.
    const two = await connect(ids.sid, {
      protocols: [SESSION_SUBPROTOCOL, `earshot.ticket.${valid}`, `earshot.ticket.${valid}`],
    });
    expect(await closeCode(two)).toBe(codeOf("ticket_refused"));
  });

  it("answers 404 for a path that isn't a lowercase session UUID", async () => {
    const ids = newSession();
    const ticket = await ticketFor(ids);
    const handshake = await connect(ids.sid, {
      ticket,
      path: `/v1/sessions/${ids.sid.toUpperCase()}/ws`,
    });
    expect(handshake.status).toBe(404);
  });
});

describe("SessionDO's checks", () => {
  it("refuses a reused ticket with ticket_reused", async () => {
    const ids = newSession();
    const ticket = await ticketFor(ids);
    const first = await connect(ids.sid, { ticket });
    expect(first.status).toBe(101);
    expect(await closeCode(await connect(ids.sid, { ticket }))).toBe(codeOf("ticket_reused"));
    first.socket?.close();
  });

  it("pins the first user and workspace, and refuses anyone else with forbidden", async () => {
    const { ids, socket } = await open();
    const otherUser = await ticketFor({ ...ids, uid: "someone-else" });
    expect(await closeCode(await connect(ids.sid, { ticket: otherUser }))).toBe(
      codeOf("forbidden"),
    );
    const otherWorkspace = await ticketFor({ ...ids, wid: crypto.randomUUID() });
    expect(await closeCode(await connect(ids.sid, { ticket: otherWorkspace }))).toBe(
      codeOf("forbidden"),
    );
    // The pinned user still gets in.
    const again = await connect(ids.sid, { ticket: await ticketFor(ids) });
    expect(again.status).toBe(101);
    expect(await socket.closed).toMatchObject({ code: codeOf("replaced") });
    again.socket?.close();
  });

  it("lets the newest connection win, closing the older one with replaced", async () => {
    const { ids, socket: older } = await open();
    const newer = await open(ids);
    expect(await older.closed).toEqual({
      code: codeOf("replaced"),
      reason: SESSION_CLOSE_CODES.replaced.reason,
    });
    expect(newer.welcome.sessionId).toBe(ids.sid);
    newer.socket.close();
  });

  it("only accepts upgrades that carry claims the edge route verified", async () => {
    const stub = sessionStub(newSession().sid);
    const response = await stub.fetch("https://session.internal/connect", {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(400);
  });

  it("answers ping with pong without a message reaching the object", async () => {
    const { socket } = await open();
    socket.sendRaw("ping");
    await socket.waitFor(() => socket.frames.includes("pong"), 2_000).catch(() => undefined);
    expect(socket.frames).toContain("pong");
    expect(socket.received.filter((m) => m.t === "error")).toEqual([]);
    socket.close();
  });
});
