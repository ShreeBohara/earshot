import { z } from "zod";

const ComponentStatus = z.enum(["ok", "error"]);

const EdgeHealth = z
  .strictObject({
    status: ComponentStatus,
    durableObject: ComponentStatus.optional(),
    env: z.string().optional(),
    version: z.string().optional(),
  })
  .meta({ title: "EdgeHealth" });

const DbHealth = z
  .strictObject({
    status: ComponentStatus,
    /** Read from the database itself, so it proves which branch the Worker reached. */
    branch: z.string().optional(),
    migrations: z.int().nonnegative().optional(),
  })
  .meta({ title: "DbHealth" });

/** Response of `GET /api/health`: proves web → edge → Durable Object and web → Postgres. */
export const HealthResponse = z
  .strictObject({
    status: z.enum(["ok", "degraded"]),
    version: z.string(),
    env: z.string(),
    edge: EdgeHealth,
    db: DbHealth,
  })
  .meta({ title: "HealthResponse", description: "Response of GET /api/health." });

export type HealthResponse = z.infer<typeof HealthResponse>;
