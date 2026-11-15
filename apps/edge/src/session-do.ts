import { DurableObject } from "cloudflare:workers";

/**
 * One Durable Object per capture session (docs/adr/0003). Phase 1 only proves that
 * SQLite-backed storage works; Phase 3 adds the WebSocket channel, the event log, and the agent loop.
 */
export class SessionDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)",
      );
    });
  }

  ping(): { ok: true; pings: number } {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (k, v) VALUES ('pings', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1",
    );
    const row = this.ctx.storage.sql
      .exec<{ v: number }>("SELECT v FROM meta WHERE k = 'pings'")
      .one();
    return { ok: true, pings: row.v };
  }
}
