import type { Metadata } from "next";
import { InboxView } from "@/components/inbox/inbox-view";
import { requireViewer } from "@/lib/auth/viewer";
import { readInbox } from "@/lib/inbox/read";

export const metadata: Metadata = { title: "Inbox · Earshot" };

/**
 * The review inbox (Phase 5 spec WP5; docs/adr/0035): the viewer's debriefs and their proposals,
 * read on the server (after the repair path seals what it can), then reviewed in the page.
 */
export default async function InboxPage() {
  const viewer = await requireViewer("/inbox");
  const data = await readInbox(viewer);
  return <InboxView initial={data} />;
}
