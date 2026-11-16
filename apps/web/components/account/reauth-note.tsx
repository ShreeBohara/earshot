import Link from "next/link";
import { linkButton } from "@/components/link-button";

/** Where to sign in again before a sensitive action, coming back here afterwards. */
export const REAUTH_HREF = `/sign-in?reauth=1&next=${encodeURIComponent("/settings/account")}`;

export function ReauthNote({ children }: { children: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-state-conflict-border bg-state-conflict-bg px-3 py-2 text-sm text-state-conflict-text">
      <p className="flex-1">{children}</p>
      <Link href={REAUTH_HREF} className={linkButton({ variant: "outline", size: "sm" })}>
        Sign in again
      </Link>
    </div>
  );
}
