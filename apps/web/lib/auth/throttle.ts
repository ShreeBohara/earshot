import { schema } from "@earshot/db";
import { sql } from "drizzle-orm";
import type { AppDb } from "../db/types";

/** A keyed hash of the address, so the table can't be reversed with a list of emails. */
async function addressKey(secret: string, email: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`magic-link-address:${email.trim().toLowerCase()}`),
  );
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Caps how many magic links one address receives, whatever IPs ask for them. Better Auth's rate
 * limiter keys on the client IP, so on its own it can't stop someone spraying sign-in requests for
 * a victim's address from many IPs. This keys on an HMAC of the address (with the auth secret)
 * in the same `rate_limit` table Better Auth uses, so the table never holds an email address and
 * can't be checked against a list of them.
 *
 * Returns false when the address is over the limit. The window slides: it resets after `windowMs`
 * without a request. Keep `windowMs` within Better Auth's longest rule window, which is how long
 * it keeps rows.
 */
export async function allowMagicLinkFor(
  db: AppDb,
  email: string,
  {
    secret,
    max,
    windowMs,
    now = Date.now(),
  }: { secret: string; max: number; windowMs: number; now?: number },
): Promise<boolean> {
  const { rateLimit } = schema;
  const [row] = await db
    .insert(rateLimit)
    .values({
      id: crypto.randomUUID(),
      key: `magic-link-address|${await addressKey(secret, email)}`,
      count: 1,
      lastRequest: now,
    })
    .onConflictDoUpdate({
      target: rateLimit.key,
      set: {
        count: sql`case when ${rateLimit.lastRequest} <= ${now - windowMs} then 1 else ${rateLimit.count} + 1 end`,
        lastRequest: now,
      },
    })
    .returning({ count: rateLimit.count });
  return (row?.count ?? 1) <= max;
}

/** At most `max` requests per `windowMs`. */
export type RateLimitRule = { readonly max: number; readonly windowMs: number };

export type RateLimitDecision = {
  readonly allowed: boolean;
  /** When `allowed` is false: seconds until the window resets and a request will pass again. */
  readonly retryAfterSeconds: number;
};

/**
 * Counts one request against `key` and decides whether it may proceed. Like the per-address cap
 * above, the counter lives in Better Auth's `rate_limit` table, so every Worker isolate shares it,
 * and one upsert both counts and decides, so concurrent requests can't slip past the limit.
 *
 * The count resets `windowMs` after the last request that was let through, the way Better Auth's
 * own limiter works. Refused requests are counted but don't move that point, so a client that
 * keeps retrying still gets through once the window ends, and `retryAfterSeconds` is accurate.
 * Namespace `key` (for example `key-check|user:<id>`) so it can't collide with Better Auth's
 * `<ip>|<path>` keys, and keep `windowMs` within Better Auth's longest rule window, which is how
 * long it keeps rows.
 */
export async function consumeRateLimit(
  db: AppDb,
  key: string,
  { max, windowMs }: RateLimitRule,
  now: number = Date.now(),
): Promise<RateLimitDecision> {
  const { rateLimit } = schema;
  const expired = sql`${rateLimit.lastRequest} <= ${now - windowMs}`;
  const [row] = await db
    .insert(rateLimit)
    .values({ id: crypto.randomUUID(), key, count: 1, lastRequest: now })
    .onConflictDoUpdate({
      target: rateLimit.key,
      set: {
        // Both expressions read the row as it was before this request.
        count: sql`case when ${expired} then 1 else ${rateLimit.count} + 1 end`,
        // Moves only when this request is let through.
        lastRequest: sql`case when ${expired} or ${rateLimit.count} < ${max} then ${now} else ${rateLimit.lastRequest} end`,
      },
    })
    .returning({ count: rateLimit.count, lastRequest: rateLimit.lastRequest });
  const count = row?.count ?? 1;
  if (count <= max) return { allowed: true, retryAfterSeconds: 0 };
  const resetsAt = Number(row?.lastRequest ?? now) + windowMs;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((resetsAt - now) / 1000)) };
}
