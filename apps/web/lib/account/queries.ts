import "server-only";
import { schema } from "@earshot/db";
import { and, desc, eq, gt } from "drizzle-orm";
import type { AppDb } from "../db/types";

export type SignInSession = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
};

/** The user's unexpired sign-in sessions, most recently active first. Never selects tokens. */
export async function listSignInSessions(
  db: AppDb,
  userId: string,
  now: Date = new Date(),
): Promise<SignInSession[]> {
  const { session } = schema;
  return db
    .select({
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
    })
    .from(session)
    .where(and(eq(session.userId, userId), gt(session.expiresAt, now)))
    .orderBy(desc(session.updatedAt));
}

/** The token of one of the user's own sessions, for Better Auth's revoke endpoint. */
export async function sessionTokenFor(
  db: AppDb,
  userId: string,
  sessionId: string,
): Promise<string | null> {
  const { session } = schema;
  const [row] = await db
    .select({ token: session.token })
    .from(session)
    .where(and(eq(session.id, sessionId), eq(session.userId, userId)));
  return row?.token ?? null;
}

export type PasskeySummary = {
  id: string;
  name: string | null;
  deviceType: string;
  backedUp: boolean;
  createdAt: Date | null;
};

/** The user's passkeys, newest first. Public keys and credential ids stay server-side. */
export async function listPasskeys(db: AppDb, userId: string): Promise<PasskeySummary[]> {
  const { passkey } = schema;
  return db
    .select({
      id: passkey.id,
      name: passkey.name,
      deviceType: passkey.deviceType,
      backedUp: passkey.backedUp,
      createdAt: passkey.createdAt,
    })
    .from(passkey)
    .where(eq(passkey.userId, userId))
    .orderBy(desc(passkey.createdAt));
}
