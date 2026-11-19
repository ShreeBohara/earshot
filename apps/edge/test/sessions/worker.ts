// The sessions project's Worker entry: the real Worker and SessionDO, with two test seams.
//
// - Extraction is the real `@earshot/agent`, answering from its committed cassettes, so no test
//   reaches a provider. A test picks a cassette per session with `useCassette`; by default every
//   turn of the demo session has its recorded answer.
// - Flush messages go to a recorder instead of the Queue, since the test APIs can't observe a
//   producer: each session's messages land in its own SQLite (`test_outbox`), where tests read
//   them and scan them for leaks. `failSink` makes the recorder throw.
import { type Cassette, cassette, createCassetteFetch } from "@earshot/agent/testing";
import type { LlmProvider } from "@earshot/core";
import { PRICE_TABLE_DATE, priceStt } from "@earshot/voice/prices";
import { productionAgent, withFetch } from "../../src/agent";
import { demoCassette } from "../../src/e2e";
import type { FlushMessage, FlushSink } from "../../src/flush-message";
import { SessionRuntime } from "../../src/session-do";

export { default } from "../../src/index";

const SETTINGS = "CREATE TABLE IF NOT EXISTS test_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)";
const OUTBOX =
  "CREATE TABLE IF NOT EXISTS test_outbox (n INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)";

function hasTable(sql: SqlStorage, name: string): boolean {
  return (
    sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray()
      .length > 0
  );
}

/** A test setting in the session's own SQLite (`test_settings`), if a test set one. */
export function testSetting(sql: SqlStorage, key: string): string | undefined {
  if (!hasTable(sql, "test_settings")) return undefined;
  return sql.exec<{ v: string }>("SELECT v FROM test_settings WHERE k = ?", key).toArray()[0]?.v;
}

export function setTestSetting(sql: SqlStorage, key: string, value: string | null): void {
  sql.exec(SETTINGS);
  if (value === null) sql.exec("DELETE FROM test_settings WHERE k = ?", key);
  else sql.exec("INSERT OR REPLACE INTO test_settings (k, v) VALUES (?, ?)", key, value);
}

/** The flush messages a session has sent, in order. */
export function recordedFlushes(sql: SqlStorage): FlushMessage[] {
  if (!hasTable(sql, "test_outbox")) return [];
  return sql
    .exec<{ body: string }>("SELECT body FROM test_outbox ORDER BY n")
    .toArray()
    .map((row) => JSON.parse(row.body) as FlushMessage);
}

/**
 * The cassette a session's next turn replays: `<scenario>` for one of `@earshot/agent`'s
 * scenarios, `<scenario>:slow` for the same answers 400 ms late, or every demo turn by default.
 */
function sessionCassette(sql: SqlStorage, provider: LlmProvider): Cassette {
  const choice = testSetting(sql, "cassette");
  if (!choice) return demoCassette(provider);
  const [name = "", mode] = choice.split(":");
  const chosen = cassette(provider, name);
  if (mode !== "slow") return chosen;
  return {
    ...chosen,
    interactions: chosen.interactions.map((interaction) => ({
      ...interaction,
      response: { ...interaction.response, delayMs: 400 },
    })),
  };
}

function recordingSink(sql: SqlStorage): FlushSink {
  return {
    async send(messages) {
      if (testSetting(sql, "sink") === "fail") throw new Error("the test sink is failing");
      sql.exec(OUTBOX);
      for (const message of messages) {
        sql.exec("INSERT INTO test_outbox (body) VALUES (?)", JSON.stringify(message));
      }
    },
  };
}

export class SessionDO extends SessionRuntime {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      agent: withFetch(productionAgent, (provider) =>
        createCassetteFetch(sessionCassette(ctx.storage.sql, provider)),
      ),
      sink: recordingSink(ctx.storage.sql),
      priceStt,
      priceTableDate: PRICE_TABLE_DATE,
      // A test can stop the clock (`freezeClock`), so timing on a slow runner can't change what
      // a rate or window test sees.
      now: () => {
        const frozen = testSetting(ctx.storage.sql, "now");
        return frozen === undefined ? Date.now() : Number(frozen);
      },
    });
  }
}
