// Logs (spec WP6 step 10): message types, codes, and counts only. Never a key, a ticket, or any
// payload text.
import { scenario } from "@earshot/agent/testing";
import { findSecretFragment } from "@earshot/keys/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canaryKey,
  connect,
  endMessage,
  newSession,
  startMessage,
  ticketFor,
  turnEndMessage,
  usageMessage,
  utteranceMessage,
} from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logs", () => {
  it("hold message types and codes only", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
    const ids = newSession();
    const ticket = await ticketFor(ids);
    const handshake = await connect(ids.sid, { ticket });
    const socket = handshake.socket;
    if (!socket) throw new Error("no socket");
    socket.send({ t: "hello", protocol: 1, lastSeq: -1 });
    await socket.waitFor((m) => m.t === "welcome");
    await socket.request(startMessage());
    const { turn } = scenario("anthropic", "demo-turn-4");
    const key = canaryKey();
    for (const utterance of turn.utterances)
      await socket.request(utteranceMessage(turn.turnId, utterance));
    await socket.request(turnEndMessage(turn.turnId, key));
    await socket.request(usageMessage("assemblyai", "universal-streaming-english", 1_000, 2_000));
    socket.sendRaw("not json");
    await socket.waitFor((m) => m.t === "error");
    await socket.request(endMessage());
    // A refused ticket is logged by its reason, never by the ticket.
    const reused = await connect(ids.sid, { ticket });
    await reused.socket?.closed;
    socket.close();
    await socket.closed;

    const log = lines.join("\n");
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) expect(line).toMatch(/^(info|warn|error) [a-z ]+( \{.*\})?$/);
    expect(findSecretFragment(log, key)).toBeUndefined();
    expect(findSecretFragment(log, ticket, 12)).toBeUndefined();
    for (const utterance of turn.utterances) expect(log).not.toContain(utterance.text.slice(0, 20));
    expect(log).not.toContain("Send Dana");
    expect(log).not.toContain("Acme");
    expect(log).toContain('turn completed {"outcome":"proposals"');
    expect(log).toContain('message refused {"reason":"not_json"}');
    expect(log).toContain('socket refused {"close":"ticket_reused"}');
  });
});
