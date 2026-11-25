// The review route's logic (Phase 5 spec §4.3, WP3, docs/adr/0032): `POST /api/sessions/:id/reviews`,
// the web Worker's writes once a session is sealed. As the key and voice routes do, every
// dependency is passed in: app/api/sessions/[id]/reviews wires it to the request (lib/reviews/
// deps.ts), and tests pass their own tenant transaction, environment, logger, and clock. Callers
// have already checked the sign-in (withViewer).
//
// The rules:
// - Same-site only, and the body is at most 25 reviews and snoozes in 64 KiB, nothing in it
//   shaped like a key.
// - Reviews need the audit signing key: without a usable one the route answers 503
//   `audit_unavailable` before touching the database. Snooze-only requests don't.
// - One `withViewerTenant` transaction per request: the session must be the viewer's own (404
//   otherwise), sealed in Postgres (409 `not_sealed` otherwise, even after `ended_at` is set), and
//   every review and snooze must keep the writers' rules (409 `stale` for a proposal decided,
//   reopened, or replaced since its card loaded; 400 for anything else), with "accept all" taking
//   only what `tierOf` (`@earshot/understanding/tiers`) leaves unmarked, as SessionDO does.
//   Resends are idempotent by `reviewId` and `snoozeId`. `writeSessionReviews` in `@earshot/db`
//   does the rest.
// - Each review records the viewer's sign-in: the method, and when the sign-in session began.
// - A record a review says was offered at review time (`seen.relinked`, Phase 5 WP12) must be a
//   company or contact the workspace's mirror holds (400 otherwise); `checkReview` lets it count
//   as offered only on a new-record proposal.
// - Every answer is `cache-control: no-store` and quotes nothing from the request.
import {
  MAX_REVIEW_REQUEST_BYTES,
  type Reviewer,
  type ReviewRouteError,
  type ReviewRouteErrorBody,
  ReviewRouteRequest,
  type ReviewRouteResponse,
  UNDO_WINDOW_MS,
  uuidv7,
} from "@earshot/core";
import {
  type ReviewPayload,
  type SessionReviewOutcome,
  type SnoozePayload,
  schema,
  writeSessionReviews,
} from "@earshot/db";
import type { ReviewRefusal } from "@earshot/events";
import type { AuditSigner } from "@earshot/keys/server";
import { tierOf } from "@earshot/understanding/tiers";
import { and, eq, inArray } from "drizzle-orm";
import { type AuditEnv, readAuditKeys } from "../audit/keys";
import type { Mode } from "../auth/config";
import type { withViewerTenant } from "../auth/viewer";
import type { Viewer } from "../auth/viewer-core";
import { isCrossSite, noStoreJson, readJsonBody } from "../keys/http";
import { type Logger, requestLogger } from "../log";

export type ReviewRouteDeps = {
  /** Runs work in a transaction pinned to the viewer's workspace and user, under RLS. */
  withViewerTenant: typeof withViewerTenant;
  /** Where EARSHOT_AUDIT_SIGNING_KEY comes from: the Worker's environment. */
  env: AuditEnv;
  /** A redacting logger (lib/log.ts). */
  log: Logger;
  now: () => Date;
  /** `development` under `next dev` only: then the committed development key signs. */
  mode: Mode;
};

/** Refusals that mean the card is out of date, not that the request is wrong. */
const STALE: ReadonlySet<ReviewRefusal> = new Set([
  "not_proposed",
  "superseded",
  "not_latest",
  "nothing_to_reopen",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refusal(
  status: number,
  error: ReviewRouteError,
  message: string,
  item?: ReviewRouteErrorBody["item"],
): Response {
  const body: ReviewRouteErrorBody = { error, message, ...(item ? { item } : {}) };
  return noStoreJson(status, body);
}

const notFound = () => refusal(404, "not_found", "That session doesn't exist, or it isn't yours.");

/**
 * `POST /api/sessions/:id/reviews` (spec §4.3): `{ reviews?: ReviewInput[], snoozes?:
 * SnoozeInput[] }`, 1 to 25 in all. Answers 200 with `ReviewRouteResponse`, where each item says
 * its seq and whether this request wrote it (`now`) or the log already held it (`before`).
 * Refusals: 403 cross-site, 404, 400 `invalid_request`, 413 `too_large`, 409 `not_sealed`, 409
 * `stale`, 503 `audit_unavailable`, 500.
 */
export async function sessionReviewsRoute(
  viewer: Viewer,
  request: Request,
  sessionId: string,
  deps: ReviewRouteDeps,
): Promise<Response> {
  const log = requestLogger(deps.log);
  try {
    if (isCrossSite(request)) {
      return refusal(403, "forbidden", "Review from Earshot's own pages.");
    }
    if (!UUID.test(sessionId)) return notFound();
    const id = sessionId.toLowerCase();
    const declared = request.headers.get("content-length");
    if (
      declared !== null &&
      /^\d+$/.test(declared) &&
      Number(declared) > MAX_REVIEW_REQUEST_BYTES
    ) {
      await request.body?.cancel().catch(() => {});
      return refusal(413, "too_large", "Send at most 64 KiB: split the batch.");
    }
    const parsed = ReviewRouteRequest.safeParse(
      await readJsonBody(request, MAX_REVIEW_REQUEST_BYTES),
    );
    if (!parsed.success) {
      // The reason only: Zod's issues can quote what was sent.
      log.warn("reviews refused", { reason: "invalid_request" });
      return refusal(
        400,
        "invalid_request",
        'Send { "reviews": […], "snoozes": […] } as JSON: 1 to 25 in all, at most 64 KiB.',
      );
    }
    const { reviews: reviewInputs, snoozes: snoozeInputs } = parsed.data;

    // Fail closed: reviews need a signed checkpoint, so they need the key.
    let signer: AuditSigner | null = null;
    if (reviewInputs.length > 0) {
      const keys = await readAuditKeys(deps.env, { mode: deps.mode, log: deps.log });
      const { signing } = keys;
      if (signing.status === "configured" || signing.status === "development") {
        signer = signing.signer;
      } else {
        log.error("reviews refused: no usable audit signing key", { signingKey: signing.status });
        return refusal(
          503,
          "audit_unavailable",
          "Reviews can't be recorded right now. Try again later.",
        );
      }
    }

    const now = deps.now();
    const by: Reviewer = {
      userId: viewer.user.id,
      auth: {
        method: viewer.session.signInMethod,
        signedInAt: viewer.session.createdAt.toISOString(),
      },
    };
    const reviews: ReviewPayload[] = reviewInputs.map((input) => {
      const decides = input.decision === "approved" || input.decision === "edited";
      return {
        ...input,
        syncEligibleAt: decides ? new Date(now.getTime() + UNDO_WINDOW_MS).toISOString() : null,
        by,
      };
    });
    const snoozes: SnoozePayload[] = snoozeInputs.map((input) => ({ ...input, by }));

    const outcome = await deps.withViewerTenant(async (tx): Promise<SessionReviewOutcome> => {
      const { sessions } = schema;
      const [row] = await tx
        .select({ userId: sessions.userId })
        .from(sessions)
        .where(and(eq(sessions.workspaceId, viewer.workspaceId), eq(sessions.id, id)))
        .limit(1);
      // Another member's session is as missing as another workspace's.
      if (!row || row.userId !== viewer.user.id) return { ok: false, reason: "not_found" };
      const unknown = await unknownRelinks(tx, viewer.workspaceId, reviews);
      if (unknown !== null) {
        return {
          ok: false,
          reason: "refused",
          kind: "review",
          index: unknown,
          refusal: "target_not_offered",
          detail: "the record offered at review time isn't in the workspace's CRM",
        };
      }
      return writeSessionReviews(
        tx,
        id,
        { reviews, snoozes },
        { signer, now, newId: uuidv7, tierOf },
      );
    }, viewer);

    if (!outcome.ok) {
      switch (outcome.reason) {
        case "not_found":
          return notFound();
        case "not_sealed":
          log.info("reviews refused", { reason: "not_sealed" });
          return refusal(
            409,
            "not_sealed",
            "This debrief is still finishing. Try again in a minute.",
          );
        case "audit_unavailable":
          return refusal(
            503,
            "audit_unavailable",
            "Reviews can't be recorded right now. Try again later.",
          );
        case "refused": {
          const item = { kind: outcome.kind ?? "review", index: outcome.index ?? 0 };
          log.warn("reviews refused", { reason: outcome.refusal ?? "refused", ...item });
          if (outcome.refusal && STALE.has(outcome.refusal)) {
            return refusal(
              409,
              "stale",
              "That card changed since it loaded. Reload it and try again.",
              item,
            );
          }
          return refusal(400, "invalid_request", "That review can't be made.", item);
        }
      }
    }

    const written = (items: readonly { id: string; seq: number; recorded: "now" | "before" }[]) =>
      items.map(({ id: itemId, seq, recorded }) => ({ id: itemId, seq, recorded }));
    const answer: ReviewRouteResponse = {
      sessionId: id,
      reviews: written(outcome.reviews),
      snoozes: written(outcome.snoozes),
      lastSeq: outcome.lastSeq,
    };
    log.info("reviews written", {
      reviews: outcome.reviews.filter((item) => item.recorded === "now").length,
      snoozes: outcome.snoozes.filter((item) => item.recorded === "now").length,
      resent: [...outcome.reviews, ...outcome.snoozes].filter((item) => item.recorded === "before")
        .length,
    });
    return noStoreJson(200, answer);
  } catch (error) {
    log.error("reviews failed", { error });
    return refusal(500, "server_error", "Something went wrong on our side. Try again later.");
  }
}

/**
 * The index of the first review whose record offered at review time (`seen.relinked`, WP12) isn't
 * a company or contact in the workspace's mirror, or null when every one is (or none names one).
 * One read for all of them, under row-level security.
 */
async function unknownRelinks(
  tx: Parameters<Parameters<ReviewRouteDeps["withViewerTenant"]>[0]>[0],
  workspaceId: string,
  reviews: readonly ReviewPayload[],
): Promise<number | null> {
  const named = reviews.flatMap((review, index) => {
    const entityId = review.seen?.relinked;
    return entityId ? [{ index, entityId }] : [];
  });
  if (named.length === 0) return null;
  const ids = [...new Set(named.map(({ entityId }) => entityId.toLowerCase()))].filter((id) =>
    UUID.test(id),
  );
  const { crmEntities } = schema;
  const found =
    ids.length === 0
      ? []
      : await tx
          .select({ id: crmEntities.id })
          .from(crmEntities)
          .where(
            and(
              eq(crmEntities.workspaceId, workspaceId),
              inArray(crmEntities.id, ids),
              inArray(crmEntities.kind, ["company", "contact"]),
            ),
          );
  const known = new Set(found.map((row) => row.id));
  const first = named.find(({ entityId }) => !known.has(entityId.toLowerCase()));
  return first ? first.index : null;
}
