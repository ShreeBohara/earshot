"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";

/** Signs this device out, then returns to the landing page. Harmless when already signed out. */
export async function signOut(): Promise<void> {
  const auth = await getAuth();
  await auth.api.signOut({ headers: await headers() });
  redirect("/");
}
