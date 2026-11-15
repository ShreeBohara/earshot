import { buttonVariants } from "@earshot/ui/components/button";

const REPO = "https://github.com/ShreeBohara/earshot";

const phases = [
  "Reset and foundations",
  "Event-sourced core, auth, and data",
  "Voice engine and the capture experience",
  "Understanding: proposals, entity linking, two witnesses",
  "The trust layer: review inbox and approval policies",
  "Real CRM sync",
  "Memory, commitments, and briefs",
  "Research: the benchmark and the two-witnesses study",
  "Everywhere: MCP, mobile, local mode, imports",
  "Production hardening and launch",
] as const;

const CURRENT_PHASE = 1;

function statusOf(phase: number): string {
  if (phase < CURRENT_PHASE) return "done";
  if (phase === CURRENT_PHASE) return "in progress";
  return "planned";
}

export default function Page() {
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col gap-12 px-6 py-16">
      <header className="flex flex-col gap-4">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-wider">
          v2 · rebuilding in the open
        </p>
        <h1 className="font-serif text-6xl tracking-tight">Earshot</h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          The open-source, verifiable voice layer for your CRM. Say it once, check it in seconds,
          sync it with proof.
        </p>
      </header>

      <section aria-labelledby="roadmap" className="flex flex-col gap-3">
        <h2 id="roadmap" className="font-medium text-sm">
          Roadmap
        </h2>
        <ol className="flex flex-col divide-y divide-border rounded-lg border">
          {phases.map((name, index) => {
            const phase = index + 1;
            return (
              <li key={name} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                <span>
                  <span className="font-mono text-muted-foreground">
                    {String(phase).padStart(2, "0")}
                  </span>{" "}
                  {name}
                </span>
                <span className="shrink-0 font-mono text-muted-foreground text-xs">
                  {statusOf(phase)}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <footer className="flex flex-wrap gap-2">
        <a className={buttonVariants({ size: "lg" })} href={REPO}>
          Source on GitHub
        </a>
        <a
          className={buttonVariants({ variant: "outline", size: "lg" })}
          href={`${REPO}/blob/main/ROADMAP.md`}
        >
          Read the roadmap
        </a>
      </footer>
    </main>
  );
}
