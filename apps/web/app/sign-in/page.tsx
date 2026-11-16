import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { MODE, readAuthConfig, socialProviderIds } from "@/lib/auth/config";
import { safeNextPath } from "@/lib/auth/redirects";
import { getViewer } from "@/lib/auth/viewer";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in · Earshot",
  robots: { index: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Better Auth sends errors back as `?error=<code>`. Only known codes get specific wording; the
 * raw value is never shown, since anyone can put anything in a URL.
 */
function errorMessage(code: string | undefined): string | null {
  if (!code) return null;
  switch (code.toUpperCase()) {
    case "INVALID_TOKEN":
    case "EXPIRED_TOKEN":
      return "That sign-in link has expired or was already used. Send yourself a new one.";
    case "ACCESS_DENIED":
      return "Sign-in was cancelled.";
    case "ACCOUNT_NOT_LINKED":
      return "An account with this email already exists. Sign in with an email link first; the provider links once the emails match and are verified.";
    case "NEW_USER_SIGNUP_DISABLED":
    case "SIGNUP_DISABLED":
      return "New sign-ups are closed on this server.";
    default:
      return "Sign-in didn't work. Try again.";
  }
}

/** Whether `next dev` prints magic links to the terminal (no email provider configured). */
function devMailHint(env: CloudflareEnv): boolean {
  if (MODE !== "development") return false;
  try {
    return readAuthConfig(env, MODE).email === null;
  } catch {
    return false;
  }
}

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const next = safeNextPath(first(params.next));
  // ?reauth=1 shows the form even when signed in: sensitive actions need a recent sign-in.
  const reauth = first(params.reauth) === "1";
  const viewer = await getViewer();
  if (viewer && !reauth) redirect(next);

  const { env } = getCloudflareContext();

  return (
    <main
      id="main"
      className="mx-auto flex min-h-svh w-full max-w-sm flex-col justify-center gap-8 px-6 py-16"
    >
      <header className="flex flex-col gap-3">
        <Link
          href="/"
          className="w-fit rounded-sm font-mono text-muted-foreground text-xs uppercase tracking-wider outline-none hover:text-foreground focus-visible:focus-ring"
        >
          Earshot
        </Link>
        <h1 className="font-serif text-5xl tracking-tight">
          {reauth ? "Confirm it’s you" : "Sign in"}
        </h1>
        <p className="text-pretty text-muted-foreground">
          {reauth
            ? "Deleting your account and adding a passkey need a recent sign-in. Sign in again to continue."
            : "No passwords. New here? The same sign-in link creates your account."}
        </p>
      </header>

      <SignInForm
        next={next}
        providers={socialProviderIds(env)}
        initialError={errorMessage(first(params.error))}
        devMailHint={devMailHint(env)}
      />

      <p className="text-muted-foreground text-xs">
        Earshot keeps your AI keys on your device.{" "}
        <Link
          href="/demo"
          className="rounded-sm underline underline-offset-4 outline-none hover:text-foreground focus-visible:focus-ring"
        >
          Try the replay demo
        </Link>{" "}
        without an account.
      </p>
    </main>
  );
}
