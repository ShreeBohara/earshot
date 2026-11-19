// The edge Worker (docs/adr/0003): the session socket's front door, the Durable Objects that hold
// sessions, and the Queue consumer that flushes them to Postgres.
import { WorkerEntrypoint } from "cloudflare:workers";
import { PRICE_TABLE_DATE, priceStt } from "@earshot/voice/prices";
import { productionAgent } from "./agent";
import { createApp } from "./app";
import { handleFlushQueue, type PurgeResult, purgeSessions, queueSink } from "./queue";
import { SessionRuntime } from "./session-do";

/** One per capture session, with production dependencies: `@earshot/agent` and the Queue. */
export class SessionDO extends SessionRuntime {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      agent: productionAgent,
      sink: queueSink(env.FLUSH),
      priceStt,
      priceTableDate: PRICE_TABLE_DATE,
    });
  }
}

const app = createApp();

/**
 * The default entrypoint: HTTP (`fetch`), the flush consumer (`queue`), and one RPC method for the
 * web app's `EDGE` service binding, `purgeSessions`. RPC methods aren't reachable over HTTP.
 */
export default class EdgeWorker extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> | Response {
    return app.fetch(request, this.env, this.ctx);
  }

  override async queue(batch: MessageBatch): Promise<void> {
    await handleFlushQueue(batch, this.env, this.ctx);
  }

  /**
   * Deletes the sessions' Durable Object storage. The web app calls it before deleting the rows of
   * a session or an account (`env.EDGE.purgeSessions(ids)`), with at most 500 ids a call.
   */
  async purgeSessions(sessionIds: readonly string[]): Promise<PurgeResult> {
    return purgeSessions(this.env, sessionIds);
  }
}
