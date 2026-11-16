"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { MAX_NAME_LENGTH } from "@/lib/account/constants";
import { sessionTokenFor } from "@/lib/account/queries";
import { getAuth } from "@/lib/auth";
import { requireViewer } from "@/lib/auth/viewer";
import { getDb } from "@/lib/db";

const PAGE = "/settings/account";

export type ActionResult = { status: "idle" | "done" | "error"; message?: string };

/** Renames the signed-in user. */
export async function updateProfile(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  await requireViewer(PAGE);
  const name = String(form.get("name") ?? "").trim();
  if (name.length > MAX_NAME_LENGTH) {
    return { status: "error", message: `Use ${MAX_NAME_LENGTH} characters or fewer.` };
  }
  const auth = await getAuth();
  await auth.api.updateUser({ headers: await headers(), body: { name } });
  revalidatePath("/", "layout");
  return { status: "done", message: "Saved." };
}

/** Signs out one of the viewer's other sessions, looked up by id so tokens never reach the page. */
export async function revokeSession(sessionId: string): Promise<ActionResult> {
  const viewer = await requireViewer(PAGE);
  if (sessionId === viewer.session.id) {
    return { status: "error", message: "To end this session, sign out from the account menu." };
  }
  const token = await sessionTokenFor(await getDb(), viewer.user.id, sessionId);
  if (token) {
    const auth = await getAuth();
    await auth.api.revokeSession({ headers: await headers(), body: { token } });
  }
  revalidatePath(PAGE);
  return { status: "done" };
}

/** Signs out every session except this one. */
export async function revokeOtherSessions(): Promise<ActionResult> {
  await requireViewer(PAGE);
  const auth = await getAuth();
  await auth.api.revokeOtherSessions({ headers: await headers() });
  revalidatePath(PAGE);
  return { status: "done", message: "Signed out everywhere else." };
}
