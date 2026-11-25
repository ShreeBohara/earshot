import { withViewer } from "@/lib/auth/viewer";
import { policyRouteDeps } from "@/lib/policies/deps";
import { putPolicyRoute } from "@/lib/policies/routes";

export const dynamic = "force-dynamic";

/**
 * Changes the workspace's approval policy (Phase 5 spec §4.6, docs/adr/0034): `{ "rules": { "v": 1,
 * "autoApprove": [...] }, "baseVersion": n }`. Needs a sign-in from the last 5 minutes (403
 * `step_up_required` otherwise). Answers `{ policy, changed }`; 409 `stale` when the policy changed
 * since the page loaded, 503 `audit_unavailable` without a signing key (lib/policies/routes.ts).
 * The new version applies from the next session.
 */
export const PUT = withViewer(async (viewer, request) =>
  putPolicyRoute(viewer, request, policyRouteDeps()),
);
