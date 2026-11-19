// Deletion (spec decision 16): purge() deletes the object's storage at once, refuses the socket
// for a while, and drops a turn still running. The web app reaches it through `purgeSessions`.

import { runDurableObjectAlarm } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { DEMO_UTTERANCES, demoTurnId } from "@earshot/agent/testing";
import { SESSION_CLOSE_CODES } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { parseRange } from "../../src/flush-message";
import {
  armAlarm,
  canaryKey,
  connect,
  meta,
  newSession,
  open,
  setMeta,
  sleep,
  startMessage,
  tableNames,
  ticketFor,
  turnEndMessage,
  usageMessage,
  useCassette,
  utteranceMessage,
  withSql,
} from "./helpers";

describe("purgeSessions", () => {
  it("deletes each session's storage, closes its socket, and refuses it until the tombstone goes", async () => {
    const { socket, stub, ids } = await open();
    await socket.request(startMessage());
    await socket.request(usageMessage("assemblyai", "universal-streaming-english", 1_000, 1_000));

    expect(await exports.default.purgeSessions([ids.sid])).toEqual({ ok: true, purged: 1 });
    expect(await socket.closed).toMatchObject({ code: SESSION_CLOSE_CODES.session_ended.code });
    expect(Object.keys(await meta(stub))).toEqual(["purged_ms"]);
    expect(parseRange(await stub.readRange(0, 10))).toEqual([]);
    await stub.confirmFlushed(5);
    expect(Object.keys(await meta(stub))).toEqual(["purged_ms"]);

    const refused = await connect(ids.sid, { ticket: await ticketFor(ids) });
    expect((await refused.socket?.closed)?.code).toBe(SESSION_CLOSE_CODES.session_ended.code);

    // The tombstone's alarm deletes the rest.
    await setMeta(stub, { purged_ms: Date.now() - 10 * 60_000 });
    await armAlarm(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await tableNames(stub)).toEqual([]);
  });

  it("drops a turn still running, so nothing is written after the purge", async () => {
    const { socket, stub, ids } = await open();
    await useCassette(stub, "demo-turn-4:slow");
    await socket.request(startMessage());
    const turnId = demoTurnId(4);
    const utterance = DEMO_UTTERANCES[3];
    if (!utterance) throw new Error("no demo utterance");
    await socket.request(utteranceMessage(turnId, utterance));
    socket.send(turnEndMessage(turnId, canaryKey()));
    await socket.waitFor((m) => m.t === "working");
    await exports.default.purgeSessions([ids.sid]);
    await sleep(600); // past the slow cassette's answer
    expect(Object.keys(await meta(stub))).toEqual(["purged_ms"]);
    expect(await withSql(stub, (sql) => sql.exec("SELECT count(*) AS n FROM events").one().n)).toBe(
      0,
    );
  });

  it("takes only lowercase session UUIDs, at most 500 at a time, and says why it refused", async () => {
    const invalid = { ok: false, reason: "invalid_session_id" };
    expect(await exports.default.purgeSessions([newSession().sid.toUpperCase()])).toEqual(invalid);
    expect(await exports.default.purgeSessions(["health"])).toEqual(invalid);
    const many = Array.from({ length: 501 }, () => newSession().sid);
    expect(await exports.default.purgeSessions(many)).toEqual({ ok: false, reason: "too_many" });
    expect(await exports.default.purgeSessions([])).toEqual({ ok: true, purged: 0 });
  });
});
