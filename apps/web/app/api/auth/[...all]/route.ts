import { getAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Better Auth's endpoints: magic links, passkeys, OAuth callbacks, sessions, account deletion. */
async function handler(request: Request): Promise<Response> {
  const auth = await getAuth();
  return auth.handler(request);
}

export { handler as DELETE, handler as GET, handler as PATCH, handler as POST, handler as PUT };
