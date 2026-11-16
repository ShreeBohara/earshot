import { KeyRoundIcon, PlayIcon } from "lucide-react";
import type { Metadata } from "next";
import { StartCard } from "@/components/start-card";
import { displayName, requireViewer } from "@/lib/auth/viewer";

export const metadata: Metadata = { title: "Home · Earshot" };

/** A minimal home until capture and the review inbox arrive (Phases 3 and 5). */
export default async function HomePage() {
  const viewer = await requireViewer("/home");

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-wider">
          {viewer.workspaceName}
        </p>
        <h1 className="font-serif text-4xl tracking-tight">Hello, {displayName(viewer.user)}</h1>
        <p className="max-w-prose text-pretty text-muted-foreground">
          Capture and the review inbox are on the way. Until then, set up your keys or watch how a
          debrief becomes CRM updates.
        </p>
      </header>

      <section aria-labelledby="get-started" className="flex flex-col gap-4">
        <h2 id="get-started" className="font-medium text-sm">
          Get started
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
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
