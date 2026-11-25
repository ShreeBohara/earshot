// What Settings → Review's approval policy reads besides the policy itself (Phase 5 WP11): the
// viewer's step-up. Pure types, shared by the server page and the client component. The route's
// own contract is `PolicyRouteRequest` and its types, in `@earshot/core`.
import type { SignInMethod } from "@earshot/core";

/** How the viewer's web session signed in, as the page's step-up needs it. */
export interface StepUpState {
  /** Whether the session may change the policy now (`isSteppedUp`). */
  readonly steppedUp: boolean;
  /** When that runs out, ISO 8601: the page asks again then. */
  readonly endsAt: string;
  readonly method: SignInMethod;
  /** Whether the account has a passkey, so the page can offer "Confirm with your passkey". */
  readonly hasPasskey: boolean;
}
