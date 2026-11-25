// The approval policy route's logic (Phase 5 spec §4.6, WP11; docs/adr/0034): `PUT /api/policies`,
// how Settings → Review changes the workspace's policy. As the key and review routes do, every
// dependency is passed in: app/api/policies wires it to the request (lib/policies/deps.ts), and
// tests pass their own tenant transaction, environment, logger, and clock. Callers have already
// checked the sign-in (withViewer).
//
// The rules:
// - Same-site only, and the body is at most 16 KiB: `{ rules, baseVersion }`, the rules holding
//   to `ApprovalPolicyRules` and `checkPolicyRules`.
// - The step-up: a sign-in from the last 5 minutes (`STEP_UP_SECONDS`), by a method Earshot
//   recorded, or 403 `step_up_required`. Checked before the body is read.
// - A change needs the audit signing key: without a usable one, 503 `audit_unavailable`, before
//   touching the database.
// - One `withViewerTenant` transaction: the workspace's policy lock, 409 `stale` for a change from
//   an older version, then the next version, a `policy.changed` audit entry with the policy's id,
//   version, rules' hash, and the viewer's sign-in, and a checkpoint (`writeApprovalPolicy`).
// - Every answer is `cache-control: no-store` and quotes nothing from the request.
import {
  checkPolicyRules,
  MAX_POLICY_REQUEST_BYTES,
  type PolicyRouteError,
  type PolicyRouteErrorBody,
  PolicyRouteRequest,
  type PolicyRouteResponse,
  type PolicyView,
  uuidv7,
} from "@earshot/core";
import { type ApprovalPolicyVersion, writeApprovalPolicy } from "@earshot/db";
import type { AuditSigner } from "@earshot/keys/server";
import { type AuditEnv, readAuditKeys } from "../audit/keys";
import type { Mode } from "../auth/config";
import { isSteppedUp } from "../auth/fresh";
import type { withViewerTenant } from "../auth/viewer";
import type { Viewer } from "../auth/viewer-core";
import { isCrossSite, noStoreJson, readJsonBody } from "../keys/http";
import { type Logger, requestLogger } from "../log";

export type PolicyRouteDeps = {
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

function refusal(
  status: number,
  error: PolicyRouteError,
  message: string,
  extra: Pick<PolicyRouteErrorBody, "currentVersion"> = {},
): Response {
  const body: PolicyRouteErrorBody = { error, message, ...extra };
  return noStoreJson(status, body);
}

/** A stored version as the route and the page describe it. */
export function policyView(policy: ApprovalPolicyVersion): PolicyView {
  return {
    id: policy.id,
    version: policy.version,
    rules: policy.rules,
    rulesSha256: policy.rulesSha256,
    createdAt: policy.createdAt.toISOString(),
    createdBy: policy.createdBy,
  };
}

/**
 * `PUT /api/policies` (spec §4.6): `{ rules, baseVersion }`. Answers 200 with
 * `PolicyRouteResponse`. Refusals: 403 cross-site, 403 `step_up_required`, 413 `too_large`, 400
 * `invalid_request`, 503 `audit_unavailable`, 409 `stale`, 500.
 */
export async function putPolicyRoute(
  viewer: Viewer,
  request: Request,
  deps: PolicyRouteDeps,
): Promise<Response> {
  const log = requestLogger(deps.log);
  try {
    if (isCrossSite(request)) {
      return refusal(403, "forbidden", "Change your approval policy from Earshot's own pages.");
    }
    const now = deps.now();
    if (!isSteppedUp(viewer.session, now)) {
      await request.body?.cancel().catch(() => {});
      log.info("policy change refused", {
        reason: "step_up_required",
        method: viewer.session.signInMethod,
      });
      return refusal(
        403,
        "step_up_required",
        "Changing an approval policy needs a sign-in from the last 5 minutes. Confirm it's you, then save again.",
      );
    }
    const declared = request.headers.get("content-length");
    if (
      declared !== null &&
      /^\d+$/.test(declared) &&
      Number(declared) > MAX_POLICY_REQUEST_BYTES
    ) {
      await request.body?.cancel().catch(() => {});
      return refusal(413, "too_large", "Send at most 16 KiB.");
    }
    const parsed = PolicyRouteRequest.safeParse(
      await readJsonBody(request, MAX_POLICY_REQUEST_BYTES),
    );
    const checked = parsed.success ? checkPolicyRules(parsed.data.rules) : null;
    if (!parsed.success || !checked?.ok) {
      // A fixed reason only: Zod's issues, and the check's problem, can echo what was sent.
      log.warn("policy change refused", { reason: "invalid_request" });
      return refusal(
        400,
        "invalid_request",
        'Send { "rules": { "v": 1, "autoApprove": [...] }, "baseVersion": n } as JSON: one rule per proposal type, each holding back only its own fields.',
      );
    }
    const { rules, baseVersion } = parsed.data;

    // Fail closed: a change needs a signed checkpoint, so it needs the key.
    const keys = await readAuditKeys(deps.env, { mode: deps.mode, log: deps.log });
    const { signing } = keys;
    let signer: AuditSigner;
    if (signing.status === "configured" || signing.status === "development") {
      signer = signing.signer;
    } else {
      log.error("policy change refused: no usable audit signing key", {
        signingKey: signing.status,
      });
      return refusal(
        503,
        "audit_unavailable",
        "Policy changes can't be recorded right now. Try again later.",
      );
    }

    const outcome = await deps.withViewerTenant(
      (tx) =>
        writeApprovalPolicy(tx, {
          rules,
          baseVersion,
          auth: {
            method: viewer.session.signInMethod,
            signedInAt: viewer.session.createdAt.toISOString(),
          },
          signer,
          newId: uuidv7,
          now,
        }),
      viewer,
    );
    if (!outcome.ok) {
      log.info("policy change refused", { reason: "stale" });
      return refusal(
        409,
        "stale",
        "Your approval policy changed since this page loaded. Reload it and try again.",
        { currentVersion: outcome.current },
      );
    }
    // Counts and codes only: never the rules.
    log.info(outcome.changed ? "policy changed" : "policy unchanged", {
      version: outcome.policy.version,
      rules: outcome.policy.rules.autoApprove.length,
      method: viewer.session.signInMethod,
    });
    const answer: PolicyRouteResponse = {
      policy: policyView(outcome.policy),
      changed: outcome.changed,
    };
    return noStoreJson(200, answer);
  } catch (error) {
    log.error("policy change failed", { error });
    return refusal(500, "server_error", "Something went wrong on our side. Try again later.");
  }
}
