// The sync retry route (Phase 6 spec §4.5, WP9): `POST /api/sync/:jobId/retry`, how a card that
// didn't sync starts the job's next attempt, under the same idempotency key, so anything that landed
// before is found again rather than written twice. WP9 builds the route, its answers, and its
// refusals; WP1 fixes what it takes.
//
// Unlike the other routes' requests, this one is exported to JSON Schema and Pydantic: it holds no
// string at all, so it needs no key-shape check, and both languages accept exactly the same bodies.
import { z } from "zod";
import { MAX_SYNC_ATTEMPTS } from "./events/shared";

/**
 * What the route takes: the attempt the page saw fail, 1 to 20. The route starts the next attempt
 * only while that one is still the job's latest, so a second click, or a second tab, can't start
 * two retries.
 */
export const SyncRouteRequest = z
  .strictObject({
    attempt: z.int().min(1).max(MAX_SYNC_ATTEMPTS),
  })
  .meta({
    title: "SyncRouteRequest",
    description:
      "The body of `POST /api/sync/:jobId/retry`: the attempt the page saw fail, so a double click can't start two retries.",
  });
export type SyncRouteRequest = z.infer<typeof SyncRouteRequest>;
