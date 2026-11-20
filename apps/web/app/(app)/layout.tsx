import { Toaster } from "@earshot/ui/components/toast";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { CaptureSessionProvider, DockedSession } from "@/components/capture/session-provider";
import { EvidenceProvider } from "@/components/evidence/evidence-provider";
import { PATHNAME_HEADER, signInPath } from "@/lib/auth/redirects";
import { displayName, getViewer } from "@/lib/auth/viewer";

/**
 * The signed-in shell. It needs the viewer for the header, so it checks the session too; each
 * page still runs its own check, because layouts don't re-render on client navigation. For the
 * same reason the capture session's provider lives here: a debrief survives moving between
 * pages, and the docked mini-session shows it everywhere but /capture. Evidence clips' provider
 * (Phase 5 WP9) is here too: it purges expired clips as the app opens, and its status line sits
 * outside `<main>`.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const viewer = await getViewer();
  if (!viewer) redirect(signInPath((await headers()).get(PATHNAME_HEADER) ?? undefined));

  return (
    <CaptureSessionProvider>
      <EvidenceProvider viewerId={viewer.user.id}>
        <div className="flex min-h-svh flex-col">
          <a
            href="#main"
            className="sr-only rounded-md bg-background px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus-visible:focus-ring"
          >
            Skip to content
          </a>
          <AppHeader
            workspaceName={viewer.workspaceName}
            name={displayName(viewer.user)}
            email={viewer.user.email}
          />
          <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
            {children}
          </main>
          <DockedSession />
          <Toaster />
        </div>
      </EvidenceProvider>
    </CaptureSessionProvider>
  );
}
