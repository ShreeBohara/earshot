import Link from "next/link";
import { redirect } from "next/navigation";
import { linkButton } from "@/components/link-button";
import { HOME_PATH } from "@/lib/auth/redirects";
import { getViewer } from "@/lib/auth/viewer";

const REPO = "https://github.com/ShreeBohara/earshot";

const STEPS = [
  { title: "Talk it through", body: "Debrief out loud after a call, in your own words." },
  { title: "Check the evidence", body: "Every proposed field points to the words behind it." },
  { title: "Sync what you approve", body: "Nothing reaches your CRM until you say so." },
] as const;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Signed-out visitors get the landing page; signed-in ones go to their workspace. */
export default async function LandingPage({ searchParams }: { searchParams: SearchParams }) {
  if (await getViewer()) redirect(HOME_PATH);
  const { deleted } = await searchParams;

  return (
    <main
      id="main"
      className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-12 px-6 py-16"
    >
      {deleted === "1" && (
        <p role="status" className="rounded-lg border px-4 py-3 text-sm">
          Your account and everything in your workspace were deleted.
        </p>
      )}

      <header className="flex flex-col gap-4">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-wider">
          Open source · bring your own key
        </p>
        <h1 className="font-serif text-6xl tracking-tight">Earshot</h1>
        <p className="text-pretty text-lg text-muted-foreground leading-relaxed">
          The open-source, verifiable voice layer for your CRM. Say it once, check it in seconds,
          sync it with proof.
        </p>
      </header>

      <ol className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex flex-col gap-1 bg-background p-4">
            <span className="font-mono text-muted-foreground text-xs">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="font-medium text-sm">{step.title}</span>
            <span className="text-pretty text-muted-foreground text-sm">{step.body}</span>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-2">
        <Link href="/sign-in" className={linkButton({ size: "lg" })}>
          Sign in
        </Link>
        <Link href="/demo" className={linkButton({ variant: "outline", size: "lg" })}>
          Try the replay demo
        </Link>
        <a href={REPO} className={linkButton({ variant: "ghost", size: "lg" })}>
          Source on GitHub
        </a>
      </div>
    </main>
  );
}
