// The correction route's logic (Phase 5 spec WP13 step 5, §4.3; docs/adr/0038):
// `POST /api/sessions/:id/corrections`, the web Worker's corrections and follow-up skips once a
// session is sealed. As the review route does, every dependency is passed in: app/api/sessions/[id]/
// corrections wires it to the request, and tests pass their own tenant transaction, logger, and
// clock. Callers have already checked the sign-in (withViewer).
//
// The rules:
// - Same-site only, the body at most 64 KiB and one correction or one skip, nothing in it shaped
//   like a key, and no text Postgres's jsonb would refuse (U+0000, or half a surrogate pair).
// - One `withViewerTenant` transaction per request: the session must be the viewer's own (404
//   otherwise) and sealed in Postgres (409 `not_sealed`), and the correction must keep the writers'
//   rules (409 `stale` for a proposal decided or replaced, or a question closed, since its card
//   loaded; 400 for anything else). `writeSessionCorrection` and `writeFollowupSkip` in
//   `@earshot/db` do the rest; resends are idempotent by `correctionId` and by question.
// - Typed words become `utterance.final` v3 with `input: "typed"` (confidence 1, no words, at the
//   session's last audio time); a dictation's, `input: "speech"`, moved to that time.
// - The words are read by `correctProposal` (no model call, no key) over the workspace's mirror,
//   as the inbox re-links (lib/inbox/relink.ts): the link index from the mirror's rows, the focus
//   account from `sessions.focus_entity_id`, the session's earlier links, the kinds the proposal's
//   type allows, the call's start, and the rep's time zone, which the request names.
// - Words with no value of the field's kind are 422 `unreadable`, and nothing is written; the page
//   says what it couldn't read from its own copy of the words.
// - No audit row and no signing key: a correction decides nothing, it makes a proposal to review.
// - Limits (ADR-0038, after a security review), answered 429 `too_many`: requests per viewer and
//   session in a window, counted in Postgres before any work, as the voice routes count theirs
//   (on in production); and in the transaction, from the log, `CORRECTION_LIMITS` in
//   `@earshot/events`: corrections per session and per window, typed characters per session, and
//   a card corrected at most `maxDepth` times over. Typed text is at most 500 characters, a
//   dictation at most 8 segments, the body at most 64 KiB.
// - Every answer is `cache-control: no-store` and quotes nothing from the request.
import { TARGET_KINDS } from "@earshot/agent/link-context";
import {
  type CorrectionRouteError,
  type CorrectionRouteErrorBody,
  CorrectionRouteRequest,
  type CorrectionRouteResponse,
  correctionProposalId,
  MAX_CORRECTION_REQUEST_BYTES,
  uuidv7,
} from "@earshot/core";
import {
  type CorrectionReadInput,
  type CorrectionWords,
  type FollowupSkipOutcome,
  type SessionCorrectionOutcome,
  schema,
  writeFollowupSkip,
  writeSessionCorrection,
} from "@earshot/db";
import { CORRECTION_LIMITS, type CorrectionRefusal } from "@earshot/events";
import { correctProposal } from "@earshot/understanding/correct";
import { and, eq } from "drizzle-orm";
import { consumeRateLimit } from "../auth/throttle";
import type { TenantTx, withViewerTenant } from "../auth/viewer";
import type { Viewer } from "../auth/viewer-core";
import type { AppDb } from "../db/types";
import { earlierLinks, mirrorIndex } from "../inbox/relink";
import { isCrossSite, noStoreJson, readJsonBody } from "../keys/http";
import { type Logger, requestLogger } from "../log";
import { loadCrmEntities } from "../voice/crm-rows";

export type CorrectionRouteDeps = {
  /** The owner connection, for the rate limit's counter. */
  db: AppDb;
  /** Runs work in a transaction pinned to the viewer's workspace and user, under RLS. */
  withViewerTenant: typeof withViewerTenant;
  /** A redacting logger (lib/log.ts). */
  log: Logger;
  now: () => Date;
  /** On in production, off under `next dev`, like the voice routes' limits. */
  rateLimit: boolean;
};

/**
 * Requests one viewer may make for one session in a window (target): the session's own window
 * limit, so attempts that write nothing (unreadable words) are bounded too.
 */
export const CORRECTION_REQUEST_LIMIT = {
  max: CORRECTION_LIMITS.perWindow,
  windowMs: CORRECTION_LIMITS.windowMs,
} as const;

/**
 * Refusals that mean the card is out of date, not that the request is wrong (syncing and synced:
 * the sync claimed it, or finished, since it loaded; Phase 6).
 */
const STALE: ReadonlySet<CorrectionRefusal> = new Set([
  "superseded",
  "not_proposed",
  "question_closed",
  "syncing",
  "synced",
]);

/** Refusals that are a limit: the session took what it may. */
const LIMITS: ReadonlySet<CorrectionRefusal> = new Set(["too_deep", "too_many"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refusal(status: number, error: CorrectionRouteError, message: string): Response {
  const body: CorrectionRouteErrorBody = { error, message };
  return noStoreJson(status, body);
}

const notFound = () => refusal(404, "not_found", "That session doesn't exist, or it isn't yours.");

/**
 * Whether `text` holds what Postgres's jsonb refuses: U+0000, or half of a surrogate pair. A scan,
 * so no input can make it slow.
 */
export function hasUnstorableText(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit === 0) return true;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Text with its ends' whitespace scanned off (no regex on the rep's words). */
function trimmed(text: string): string {
  let start = 0;
  let end = text.length;
  const space = (unit: number) => unit === 0x20 || (unit >= 0x09 && unit <= 0x0d) || unit === 0xa0;
  while (start < end && space(text.charCodeAt(start))) start += 1;
  while (end > start && space(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/** The request's words as `@earshot/db` takes them, trimmed, or null when nothing's left to store. */
function wordsOf(
  said: Extract<CorrectionRouteRequest, { t: "correct" }>["said"],
): CorrectionWords | null {
  if (said.input === "typed") {
    const text = trimmed(said.text);
    return text === "" || hasUnstorableText(text) ? null : { input: "typed", text };
  }
  const utterances = said.utterances.map((segment) => ({
    ...segment,
    text: trimmed(segment.text),
  }));
  const unstorable = utterances.some(
    (segment) =>
      segment.text === "" ||
      hasUnstorableText(segment.text) ||
      (segment.words ?? []).some((word) => hasUnstorableText(word.w)),
  );
  return unstorable ? null : { input: "speech", utterances };
}

/**
 * Reads the words over the workspace's mirror (spec WP13 step 5): the link index from the mirror's
 * rows (the 250 most recent of each kind, and the focus account with its contacts and deals), the
 * focus account from the session's row, and the context SessionDO's linker had.
 */
function mirrorReader(
  tx: TenantTx,
  workspaceId: string,
  focusEntityId: string | null,
  timeZone: string,
) {
  return async (input: CorrectionReadInput) => {
    const index = mirrorIndex(await loadCrmEntities(tx, workspaceId, focusEntityId));
    return correctProposal(input.original, input.field, input.utterances, {
      index,
      focusEntityId,
      recent: earlierLinks(input.original, input.proposals),
      kinds: TARGET_KINDS[input.original.type],
      callTime: input.session.startedAt,
      timeZone,
    });
  };
}

type Written =
  | { readonly kind: "correction"; readonly outcome: SessionCorrectionOutcome }
  | { readonly kind: "skip"; readonly outcome: FollowupSkipOutcome }
  | { readonly kind: "not_found" };

/**
 * `POST /api/sessions/:id/corrections` (spec WP13 step 5): one correction, `{ t: "correct",
 * correctionId, proposalId, field, questionId?, said, timeZone? }`, or one skip, `{ t: "skip",
 * questionId }`. Answers 200 with `CorrectionRouteResponse`. Refusals: 403 cross-site, 404, 400
 * `invalid_request`, 413 `too_large`, 409 `not_sealed`, 409 `stale`, 422 `unreadable`, 500.
 */
export async function sessionCorrectionsRoute(
  viewer: Viewer,
  request: Request,
  sessionId: string,
  deps: CorrectionRouteDeps,
): Promise<Response> {
  const log = requestLogger(deps.log);
  try {
    if (isCrossSite(request)) {
      return refusal(403, "forbidden", "Correct proposals from Earshot's own pages.");
    }
    if (!UUID.test(sessionId)) return notFound();
    const id = sessionId.toLowerCase();
    const declared = request.headers.get("content-length");
    if (
      declared !== null &&
      /^\d+$/.test(declared) &&
      Number(declared) > MAX_CORRECTION_REQUEST_BYTES
    ) {
      await request.body?.cancel().catch(() => {});
      return refusal(413, "too_large", "Send at most 64 KiB.");
    }
    const parsed = CorrectionRouteRequest.safeParse(
      await readJsonBody(request, MAX_CORRECTION_REQUEST_BYTES),
    );
    const invalid = () =>
      refusal(
        400,
        "invalid_request",
        'Send one correction, { "t": "correct", … }, or one skip, { "t": "skip", "questionId": … }, as JSON.',
      );
    if (!parsed.success) {
      // The reason only: Zod's issues can quote what was sent.
      log.warn("correction refused", { reason: "invalid_request" });
      return invalid();
    }
    const body = parsed.data;
    const words = body.t === "correct" ? wordsOf(body.said) : null;
    if (body.t === "correct" && words === null) {
      log.warn("correction refused", { reason: "unstorable_text" });
      return invalid();
    }
    if (deps.rateLimit) {
      // Per viewer and session, so nobody else's requests can use up a session's allowance.
      const decision = await consumeRateLimit(
        deps.db,
        `corrections|user:${viewer.user.id}|session:${id}`,
        CORRECTION_REQUEST_LIMIT,
        deps.now().getTime(),
      );
      if (!decision.allowed) {
        log.warn("correction refused", { reason: "rate_limited" });
        return noStoreJson(
          429,
          {
            error: "too_many",
            message: "Too many corrections for this debrief just now. Try again in a few minutes.",
          } satisfies CorrectionRouteErrorBody,
          { "retry-after": String(decision.retryAfterSeconds) },
        );
      }
    }

    const now = deps.now();
    const written = await deps.withViewerTenant(async (tx): Promise<Written> => {
      const { sessions } = schema;
      const [row] = await tx
        .select({ userId: sessions.userId, focusEntityId: sessions.focusEntityId })
        .from(sessions)
        .where(and(eq(sessions.workspaceId, viewer.workspaceId), eq(sessions.id, id)))
        .limit(1);
      // Another member's session is as missing as another workspace's.
      if (!row || row.userId !== viewer.user.id) return { kind: "not_found" };
      if (body.t === "skip") {
        return {
          kind: "skip",
          outcome: await writeFollowupSkip(tx, id, body.questionId.toLowerCase(), {
            now,
            newId: uuidv7,
          }),
        };
      }
      const outcome = await writeSessionCorrection(
        tx,
        id,
        {
          correctionId: body.correctionId.toLowerCase(),
          proposalId: body.proposalId.toLowerCase(),
          field: body.field,
          questionId: body.questionId?.toLowerCase() ?? null,
          words: words as CorrectionWords,
        },
        {
          now,
          newId: uuidv7,
          proposalIdFor: correctionProposalId,
          read: mirrorReader(tx, viewer.workspaceId, row.focusEntityId, body.timeZone ?? "UTC"),
        },
      );
      return { kind: "correction", outcome };
    }, viewer);

    if (written.kind === "not_found") return notFound();
    const { outcome } = written;
    if (!outcome.ok) {
      switch (outcome.reason) {
        case "not_found":
          return notFound();
        case "not_sealed":
          log.info("correction refused", { reason: "not_sealed" });
          return refusal(
            409,
            "not_sealed",
            "This debrief is still finishing. Correct it on the capture screen, or try again in a minute.",
          );
        case "unreadable":
          // Codes only: never the words.
          log.info("correction unreadable", { kind: outcome.unreadable?.kind ?? null });
          return refusal(
            422,
            "unreadable",
            "Earshot couldn't read a value of that kind in those words, so nothing changed.",
          );
        case "refused": {
          log.warn("correction refused", { reason: outcome.refusal ?? "refused" });
          if (outcome.refusal && LIMITS.has(outcome.refusal)) {
            return refusal(
              429,
              "too_many",
              outcome.refusal === "too_deep"
                ? "That card was corrected as many times as it can be. Edit it or reject it instead."
                : "This debrief took as many corrections as it can. Edit or reject the rest.",
            );
          }
          if (outcome.refusal && STALE.has(outcome.refusal)) {
            return refusal(
              409,
              "stale",
              "That card changed since it loaded. Reload it and try again.",
            );
          }
          return refusal(400, "invalid_request", "That correction can't be made.");
        }
      }
    }

    const answer: CorrectionRouteResponse = written.outcome.ok
      ? written.kind === "skip"
        ? {
            sessionId: id,
            outcome: "skipped",
            proposalId: null,
            recorded: written.outcome.recorded,
            lastSeq: written.outcome.lastSeq,
          }
        : {
            sessionId: id,
            outcome: "corrected",
            proposalId: written.outcome.proposalId,
            recorded: written.outcome.recorded,
            lastSeq: written.outcome.lastSeq,
          }
      : // Unreachable: every refusal answered above.
        { sessionId: id, outcome: "skipped", proposalId: null, recorded: "now", lastSeq: 0 };
    log.info(written.kind === "skip" ? "follow-up skipped" : "correction written", {
      recorded: answer.recorded,
      ...(body.t === "correct"
        ? { field: body.field === "target" ? "target" : "field", input: body.said.input }
        : {}),
    });
    return noStoreJson(200, answer);
  } catch (error) {
    log.error("correction failed", { error });
    return refusal(500, "server_error", "Something went wrong on our side. Try again later.");
  }
}
