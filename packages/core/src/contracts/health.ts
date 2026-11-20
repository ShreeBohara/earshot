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

const AuditHealth = z
  .strictObject({
    /**
     * Whether the web Worker can sign audit checkpoints (docs/adr/0033): `configured` (a usable
     * EARSHOT_AUDIT_SIGNING_KEY), `development` (the committed development key, `next dev`
     * only), `missing`, or `invalid`. Writes that need a checkpoint fail closed with either of
     * the last two. Never the key itself.
     */
    signingKey: z.enum(["configured", "development", "missing", "invalid"]),
  })
  .meta({ title: "AuditHealth" });

/** Response of `GET /api/health`: proves web → edge → Durable Object and web → Postgres. */
export const HealthResponse = z
  .strictObject({
    status: z.enum(["ok", "degraded"]),
    version: z.string(),
    env: z.string(),
    edge: EdgeHealth,
    db: DbHealth,
    /** Reported, not part of `status`: optional because older web Workers don't send it. */
    audit: AuditHealth.optional(),
  })
  .meta({ title: "HealthResponse", description: "Response of GET /api/health." });

export type HealthResponse = z.infer<typeof HealthResponse>;
