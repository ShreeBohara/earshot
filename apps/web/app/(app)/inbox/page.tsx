import type { Metadata } from "next";
import { addMatchingRecordAction, simulateCrmChangeAction } from "@/app/actions/inbox-demo";
import { InboxView } from "@/components/inbox/inbox-view";
import { requireViewer } from "@/lib/auth/viewer";
import { readInbox } from "@/lib/inbox/read";

export const metadata: Metadata = { title: "Inbox · Earshot" };

/** The demo controls' server actions (Phase 5 WP12), handed to the page's client view. */
const DEMO_ACTIONS = { simulate: simulateCrmChangeAction, addMatching: addMatchingRecordAction };

/**
 * The review inbox (Phase 5 spec WP5; docs/adr/0035): the viewer's debriefs and their proposals,
 * read on the server (after the repair path seals what it can), then reviewed in the page, with
 * the demo controls on cards whose record is a demo record (WP12).
 */
export default async function InboxPage() {
  const viewer = await requireViewer("/inbox");
  const data = await readInbox(viewer);
  return <InboxView initial={data} demoActions={DEMO_ACTIONS} />;
}
