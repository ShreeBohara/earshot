// The approval policy route (Phase 5 spec §4.6, WP11; docs/adr/0034): `PUT /api/policies`, how
// Settings → Review changes the workspace's policy once the viewer has stepped up.
//
// Like the review route's, these schemas aren't exported to JSON Schema or Pydantic: only
// TypeScript speaks the route. The rules themselves are `ApprovalPolicyRules`, which is.
import { z } from "zod";
import { ApprovalPolicyRules } from "./approval-policy";

/**
 * The largest request body the route reads: 16 KiB of UTF-8 (target). The largest policy the
 * contract allows, 12 rules of 10 fields of 64 characters, takes under 10 KiB.
 */
export const MAX_POLICY_REQUEST_BYTES = 16_384;

/**
 * What the route takes: the new rules, and the version the page changed them from (the latest
 * when it loaded, or 0 when there was none), so two tabs can't silently overwrite each other. The
 * route also holds the rules to `checkPolicyRules`.
 */
export const PolicyRouteRequest = z.strictObject({
  rules: ApprovalPolicyRules,
  baseVersion: z.int().nonnegative(),
});
export type PolicyRouteRequest = z.infer<typeof PolicyRouteRequest>;

/** A version of the workspace's policy, as the route and the page describe it. */
export interface PolicyView {
  readonly id: string;
  readonly version: number;
  readonly rules: ApprovalPolicyRules;
  /** Lowercase hex SHA-256 of the rules' canonical JSON, as the version's audit entry has it. */
  readonly rulesSha256: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** Who changed it: their user id, or null once they've left the workspace. */
  readonly createdBy: string | null;
}

/** `PUT /api/policies`, 200: the workspace's policy is the request's rules. */
export interface PolicyRouteResponse {
  readonly policy: PolicyView;
  /** False when the rules were the latest version's already, so nothing was written. */
  readonly changed: boolean;
}

/**
 * Why the route refused a request: a fixed code, and nothing quoted from the request.
 *
 * - `step_up_required` (403): changing a policy needs a sign-in from the last 5 minutes. Confirm
 *   with a passkey, or sign in again, then retry.
 * - `stale` (409): the policy changed since the page loaded. Reload it.
 * - `audit_unavailable` (503): a change needs a signed checkpoint, and the deployment has no
 *   usable signing key.
 */
export type PolicyRouteError =
  | "unauthorized"
  | "forbidden"
  | "step_up_required"
  | "invalid_request"
  | "too_large"
  | "stale"
  | "audit_unavailable"
  | "server_error";

/** The body of every refusal. */
export interface PolicyRouteErrorBody {
  readonly error: PolicyRouteError;
  readonly message: string;
  /** For `stale`: the latest version now, or 0. */
  readonly currentVersion?: number;
}
