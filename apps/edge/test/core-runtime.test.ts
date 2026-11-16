import {
  parseClientMessage,
  SESSION_CLOSE_CODES,
  SESSION_SUBPROTOCOL,
  signTicket,
  ticketClaims,
  ticketFromSubprotocols,
  ticketSubprotocol,
  uuidv7,
  verifyTicket,
} from "@earshot/core";
import { describe, expect, it } from "vitest";

// The edge Worker will verify session tickets, and SessionDO will mint event ids and parse client
// messages, with @earshot/core's code as it runs in Node. These tests run it inside workerd.
const SECRET = "test-only-ticket-secret-0123456789abcdef";

describe("@earshot/core in workerd", () => {
  it("signs and verifies a session ticket with WebCrypto", async () => {
    const now = new Date();
    const claims = ticketClaims({ sid: uuidv7(), uid: "u_test", wid: uuidv7(), now });
    const ticket = await signTicket(SECRET, claims);
    const header = [SESSION_SUBPROTOCOL, ticketSubprotocol(ticket)].join(", ");
    expect(await verifyTicket(SECRET, ticketFromSubprotocols(header) ?? "", now)).toEqual({
      ok: true,
      claims,
    });
    const otherSecret = "another-test-only-ticket-secret-0123456789";
    expect(await verifyTicket(otherSecret, ticket, now)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("mints UUIDv7s in order", () => {
    const ids = Array.from({ length: 1000 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("parses client messages, and refuses a key outside turn_end", () => {
    const hello = { t: "hello", protocol: 1, lastSeq: -1 };
    expect(parseClientMessage(JSON.stringify(hello))).toEqual({ ok: true, message: hello });
    const usage = {
      t: "usage",
      msgId: uuidv7(),
      provider: "assemblyai",
      model: `sk-proj-${"y".repeat(40)}`,
      audioMs: 1000,
      socketMs: 1200,
    };
    expect(parseClientMessage(JSON.stringify(usage))).toEqual({ ok: false, reason: "stray_key" });
  });

  it("closes a socket with every session close code and its reason", async () => {
    for (const { code, reason } of Object.values(SESSION_CLOSE_CODES)) {
      const { 0: client, 1: server } = new WebSocketPair();
      client.accept();
      server.accept();
      const closed = new Promise<CloseEvent>((resolve) => {
        client.addEventListener("close", resolve);
      });
      server.close(code, reason);
      const event = await closed;
      expect({ code: event.code, reason: event.reason }).toEqual({ code, reason });
    }
  });

  it("refuses a close reason over 123 bytes, the limit the close codes are held to", () => {
    const openServerEnd = () => {
      const { 0: client, 1: server } = new WebSocketPair();
      client.accept();
      server.accept();
      return server;
    };
    expect(() => openServerEnd().close(4000, "x".repeat(123))).not.toThrow();
    expect(() => openServerEnd().close(4000, "x".repeat(124))).toThrow();
  });
});
