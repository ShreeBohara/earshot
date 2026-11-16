// Session freshness: how recent a sign-in must be before a sensitive action. Pure, so pages,
// route handlers, and tests share one rule, and it matches Better Auth's own check
// (`session.freshAge`, which createAuth sets from the same constant).

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
