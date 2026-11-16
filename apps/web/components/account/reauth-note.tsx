import Link from "next/link";
import { linkButton } from "@/components/link-button";

/** Where to sign in again before a sensitive action, coming back to `next` afterwards. */
export function reauthHref(next: string): string {
  return `/sign-in?reauth=1&next=${encodeURIComponent(next)}`;
}

/** Signing in again from the account page. */
export const REAUTH_HREF = reauthHref("/settings/account");

export function ReauthNote({
  children,
  next = "/settings/account",
}: {
  children: string;
  /** The page to come back to after signing in. */
  next?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-state-conflict-border bg-state-conflict-bg px-3 py-2 text-sm text-state-conflict-text">
      <p className="flex-1">{children}</p>
      <Link href={reauthHref(next)} className={linkButton({ variant: "outline", size: "sm" })}>
        Sign in again
      </Link>
    </div>
  );
}
