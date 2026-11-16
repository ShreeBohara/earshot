import { ensureWorkspace, resolveWorkspace, schema } from "@earshot/db";
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../db/types";
import type { Auth } from "./server";

/** The signed-in user, their sign-in session, and the workspace this request acts in. */
export type Viewer = {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image: string | null;
    createdAt: Date;
  };
  /** The sign-in session, without its token. */
  session: { id: string; createdAt: Date; expiresAt: Date };
  /** Chosen by `resolveWorkspace`: always one the user is a member of. */
  workspaceId: string;
  workspaceName: string;
  role: string;
};

/**
 * Resolves the viewer behind a request's headers: a valid Better Auth session, then the user's
 * workspace on the owner connection. A user with no workspace gets one here (`ensureWorkspace`),
 * so a failed sign-up hook can't strand them. Returns null when there's no valid session.
 */
export async function loadViewer({
  auth,
  db,
  headers,
}: {
  auth: Auth;
  db: AppDb;
  headers: Headers;
}): Promise<Viewer | null> {
  const result = await auth.api.getSession({ headers });
  if (!result) return null;
  const { user, session } = result;

  const workspaceId =
    (await resolveWorkspace(db, user.id)) ?? (await ensureWorkspace(db, user)).workspaceId;
  const { workspaceMembers, workspaces } = schema;
  const [membership] = await db
    .select({ role: workspaceMembers.role, name: workspaces.name })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user.id)),
    );
  if (!membership) return null;

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image ?? null,
      createdAt: new Date(user.createdAt),
    },
    session: {
      id: session.id,
      createdAt: new Date(session.createdAt),
      expiresAt: new Date(session.expiresAt),
    },
    workspaceId,
    workspaceName: membership.name,
    role: membership.role,
  };
}

/** What to call the viewer in the UI: their name, or the part of their email before the @. */
export function displayName(user: Pick<Viewer["user"], "name" | "email">): string {
  return user.name.trim() || user.email.split("@")[0] || user.email;
}
