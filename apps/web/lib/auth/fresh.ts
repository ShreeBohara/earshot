// Session freshness: how recent a sign-in must be before a sensitive action. Pure, so pages,
// route handlers, and tests share one rule, and it matches Better Auth's own check
// (`session.freshAge`, which createAuth sets from the same constant). Both rules read the sign-in
// session's `createdAt`, which Better Auth sets when the user signs in and never moves: a refresh
// extends `expiresAt` on the same row, and signing in again makes a new row.
import type { SignInMethod } from "@earshot/core";

/**
 * How recent a sign-in must be for sensitive actions: deleting the account, adding a passkey,
 * and storing a key in the server vault. Older sessions must sign in again first.
 */
export const FRESH_SESSION_SECONDS = 60 * 60;

/** Whether a session counts as fresh: signed in less than FRESH_SESSION_SECONDS ago. */
export function isFreshSession(
  session: { readonly createdAt: Date },
  now: Date = new Date(),
): boolean {
  return now.getTime() - session.createdAt.getTime() < FRESH_SESSION_SECONDS * 1000;
}

/**
 * The step-up for changing an approval policy (Phase 5 spec §4.6, WP11; target): a sign-in from
 * the last 5 minutes. A policy decides which proposals reach the CRM with no one looking, so it
 * asks more than the hour other sensitive actions do. Settings → Review offers "Confirm with your
 * passkey", or a fresh sign-in by email link or a provider, to get one.
 */
export const STEP_UP_SECONDS = 5 * 60;

/**
 * Whether a sign-in session may change an approval policy: it began less than STEP_UP_SECONDS
 * ago, by a method Earshot recorded (`signInMethod` isn't `unknown`), so the change's audit entry
 * can say how its author signed in. A session that began ahead of this clock (two clocks) counts
 * as just begun.
 */
export function isSteppedUp(
  session: { readonly createdAt: Date; readonly signInMethod: SignInMethod },
  now: Date = new Date(),
): boolean {
  if (session.signInMethod === "unknown") return false;
  return now.getTime() - session.createdAt.getTime() < STEP_UP_SECONDS * 1000;
}

/** When a session's step-up runs out: its sign-in plus STEP_UP_SECONDS. */
export function stepUpEndsAt(session: { readonly createdAt: Date }): Date {
  return new Date(session.createdAt.getTime() + STEP_UP_SECONDS * 1000);
}
