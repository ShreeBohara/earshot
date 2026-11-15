import { Hono } from "hono";

export { SessionDO } from "./session-do";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", async (c) => {
  const stub = c.env.SESSION.get(c.env.SESSION.idFromName("health"));
  const ping = await stub.ping();
  return c.json({
    status: "ok",
    durableObject: ping.ok ? "ok" : "error",
    env: c.env.DEPLOY_ENV,
    version: c.env.GIT_SHA,
  });
});

export default app;
