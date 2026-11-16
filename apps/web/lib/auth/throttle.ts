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
