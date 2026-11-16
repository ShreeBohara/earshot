import { demoCrmStatus } from "@earshot/db";
import { KeyRoundIcon, PlayIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DemoCrmStartCard } from "@/components/demo-crm-controls";
import { StartCard } from "@/components/start-card";
import { displayName, requireViewer, withViewerTenant } from "@/lib/auth/viewer";

export const metadata: Metadata = { title: "Welcome · Earshot" };

/** Where new users land after their first sign-in (Better Auth's newUserCallbackURL). */
export default async function OnboardingPage() {
  const viewer = await requireViewer("/onboarding");
  const demoCrm = await withViewerTenant((tx) => demoCrmStatus(tx), viewer);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-10 py-6">
      <header className="flex flex-col gap-3">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-wider">
          Your workspace is ready
        </p>
        <h1 className="font-serif text-5xl tracking-tight">Welcome, {displayName(viewer.user)}</h1>
        <p className="text-pretty text-lg text-muted-foreground leading-relaxed">
          Earshot turns a spoken debrief into CRM updates you approve, with the words that support
          every field. Pick a way to start.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <StartCard
          href="/settings/keys"
          icon={KeyRoundIcon}
          title="Add an AI key"
          action="Add a key"
        >
          Bring your own speech-to-text and model keys. They stay encrypted on this device and go
          only with the requests that need them.
        </StartCard>
        <StartCard
          href="/demo"
          icon={PlayIcon}
          title="Try the replay demo"
          action="Watch the replay"
        >
          See a recorded debrief become proposals, each field linked to its evidence. No key needed.
        </StartCard>
      </div>

      <DemoCrmStartCard counts={demoCrm.counts} loaded={demoCrm.loaded > 0} />

      <p className="text-muted-foreground text-sm">
        You can do any of these later.{" "}
        <Link
          href="/home"
          className="rounded-sm underline underline-offset-4 outline-none hover:text-foreground focus-visible:focus-ring"
        >
          Skip to your workspace
        </Link>
      </p>
    </div>
  );
}
