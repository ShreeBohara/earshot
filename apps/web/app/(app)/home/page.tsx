import { ArrowRightIcon, InboxIcon, KeyRoundIcon, MicIcon, PlayIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { StartCard } from "@/components/start-card";
import { displayName, requireViewer } from "@/lib/auth/viewer";
import { getReviewCount } from "@/lib/inbox/count";

export const metadata: Metadata = { title: "Home · Earshot" };

/** "3 proposals wait for your review." */
function waitingWords(count: number | null): string {
  if (count === null) return "Your debriefs' proposals wait in the inbox until you review them.";
  if (count === 0) return "Nothing waits for your review.";
  return `${count} ${count === 1 ? "proposal waits" : "proposals wait"} for your review.`;
}

/**
 * Today (spec WP6 step 4): what waits for review, from the same count as the header's "Inbox"
 * (one count query, shared with the header in this render), then the ways to get started.
 */
export default async function HomePage() {
  const viewer = await requireViewer("/home");
  const count = await getReviewCount();

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-wider">
          {viewer.workspaceName}
        </p>
        <h1 className="font-serif text-4xl tracking-tight">Hello, {displayName(viewer.user)}</h1>
        <p className="max-w-prose text-pretty text-muted-foreground">
          Debrief a call while it&apos;s fresh, then review what Earshot proposed. Nothing reaches
          your CRM until you accept it.
        </p>
      </header>

      <section
        aria-labelledby="to-review"
        className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-5 text-card-foreground"
      >
        <div className="flex items-start gap-3">
          <InboxIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="flex flex-col gap-1">
            <h2 id="to-review" className="font-medium text-base">
              To review
            </h2>
            <p className="text-pretty text-muted-foreground text-sm" data-slot="review-count">
              {waitingWords(count)}
            </p>
          </div>
        </div>
        <Link
          href="/inbox"
          className="inline-flex items-center gap-1 rounded-md font-medium text-sm outline-none hover:underline hover:underline-offset-4 focus-visible:focus-ring"
        >
          Open the inbox
          <ArrowRightIcon aria-hidden="true" className="size-4" />
        </Link>
      </section>

      <section aria-labelledby="get-started" className="flex flex-col gap-4">
        <h2 id="get-started" className="font-medium text-sm">
          Get started
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StartCard
            href="/capture"
            icon={MicIcon}
            title="Debrief a call"
            action="Start a debrief"
            headingLevel="h3"
          >
            Hold to talk; Earshot drafts CRM changes with the words they came from.
          </StartCard>
          <StartCard
            href="/settings/keys"
            icon={KeyRoundIcon}
            title="Add an AI key"
            action="Add a key"
            headingLevel="h3"
          >
            Earshot runs on your own provider keys, kept on this device.
          </StartCard>
          <StartCard
            href="/demo"
            icon={PlayIcon}
            title="Try the replay demo"
            action="Watch the replay"
            headingLevel="h3"
          >
            A recorded debrief, replayed into proposals with their evidence.
          </StartCard>
        </div>
      </section>
    </div>
  );
}
