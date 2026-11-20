import Link from "next/link";
import { Suspense } from "react";
import { getReviewCount } from "@/lib/inbox/count";
import { InboxNavLink } from "./inbox-nav-link";
import { UserMenu } from "./user-menu";

/**
 * "Inbox" with its count, from one count query (lib/inbox/count.ts). It streams in behind the
 * header, so the query never holds up the page: until it lands, the link says "Inbox" alone.
 */
async function InboxNavCount() {
  const count = await getReviewCount();
  return <InboxNavLink count={count} renderedAt={new Date().toISOString()} />;
}

/** The signed-in header: the wordmark, the current workspace, the pages, and the account menu. */
export function AppHeader({
  workspaceName,
  name,
  email,
}: {
  workspaceName: string;
  name: string;
  email: string;
}) {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-6">
        <Link
          href="/home"
          className="rounded-sm font-serif text-xl tracking-tight outline-none focus-visible:focus-ring"
        >
          Earshot
        </Link>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <p className="min-w-0 truncate font-medium text-sm">
          <span className="sr-only">Workspace: </span>
          {workspaceName}
        </p>
        <nav aria-label="Main" className="ms-auto flex items-center gap-1">
          <Link
            href="/home"
            className="hidden rounded-md px-2 py-1.5 text-muted-foreground text-sm outline-none hover:bg-muted hover:text-foreground focus-visible:focus-ring sm:inline-flex"
          >
            Home
          </Link>
          <Suspense fallback={<InboxNavLink count={null} renderedAt="" />}>
            <InboxNavCount />
          </Suspense>
          <Link
            href="/capture"
            className="rounded-md px-2 py-1.5 text-muted-foreground text-sm outline-none hover:bg-muted hover:text-foreground focus-visible:focus-ring"
          >
            Capture
          </Link>
          <Link
            href="/demo"
            className="hidden rounded-md px-2 py-1.5 text-muted-foreground text-sm outline-none hover:bg-muted hover:text-foreground focus-visible:focus-ring sm:inline-flex"
          >
            Replay demo
          </Link>
        </nav>
        <UserMenu name={name} email={email} />
      </div>
    </header>
  );
}
