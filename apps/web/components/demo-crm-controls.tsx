"use client";

import { Button } from "@earshot/ui/components/button";
import { StatePill } from "@earshot/ui/components/state-pill";
import { toast } from "@earshot/ui/components/toast";
import { DatabaseIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { type DemoCrmResult, loadDemoCrmAction, removeDemoCrmAction } from "@/app/actions/demo-crm";
import { type DemoCrmCounts, describeDemoCrm } from "@/lib/demo-crm";

function report(result: DemoCrmResult) {
  toast.add({ title: result.message, type: result.status === "error" ? "error" : "success" });
}

/** Onboarding's third way to start: load the demo CRM, then carry on. */
export function DemoCrmStartCard({ counts, loaded }: { counts: DemoCrmCounts; loaded: boolean }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    startTransition(async () => {
      const result = await loadDemoCrmAction();
      setMessage(result.message);
    });
  }

  return (
    <section
      aria-labelledby="demo-crm-start"
      className="flex flex-col gap-4 rounded-xl border bg-card p-5 text-card-foreground sm:flex-row sm:items-center"
    >
      <DatabaseIcon
        aria-hidden="true"
        className="size-5 shrink-0 text-muted-foreground sm:mt-0.5 sm:self-start"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 id="demo-crm-start" className="font-medium text-base">
          Load the demo CRM
        </h2>
        <p className="text-pretty text-muted-foreground text-sm">
          {describeDemoCrm(counts)}. Try Earshot before you connect a real CRM, and remove it
          anytime in{" "}
          <Link
            href="/settings/data"
            className="whitespace-nowrap rounded-sm underline underline-offset-4 outline-none hover:text-foreground focus-visible:focus-ring"
          >
            Settings → Data
          </Link>
          .
        </p>
        <p role="status" className="text-sm">
          {message ?? ""}
        </p>
      </div>
      {loaded ? (
        <StatePill state="synced" className="self-start sm:self-center">
          Loaded
        </StatePill>
      ) : (
        <Button
          variant="outline"
          disabled={pending}
          onClick={load}
          className="self-start sm:self-center"
        >
          {pending ? "Loading…" : "Load the demo CRM"}
        </Button>
      )}
    </section>
  );
}

/** Settings → Data: the demo CRM's state, with load and remove. */
export function DemoCrmSettings({ loaded, total }: { loaded: number; total: number }) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  function run(action: () => Promise<DemoCrmResult>) {
    setConfirming(false);
    startTransition(async () => report(await action()));
  }

  const state =
    loaded === 0
      ? {
          pill: <StatePill state="neutral">Not loaded</StatePill>,
          text: "Your workspace has none of it.",
        }
      : loaded < total
        ? {
            pill: <StatePill state="conflict">Partly loaded</StatePill>,
            text: `${loaded} of its ${total} records are in your workspace. Loading again adds the rest.`,
          }
        : {
            pill: <StatePill state="synced">Loaded</StatePill>,
            text: `All ${total} records are in your workspace.`,
          };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3">
        {state.pill}
        <p className="min-w-0 flex-1 text-muted-foreground text-sm">{state.text}</p>
        <div className="flex flex-wrap items-center gap-2">
          {loaded < total && (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => run(loadDemoCrmAction)}
            >
              {pending ? "Working…" : loaded === 0 ? "Load the demo CRM" : "Load the rest"}
            </Button>
          )}
          {loaded > 0 &&
            (confirming ? (
              <>
                <Button
                  ref={confirmRef}
                  variant="destructive"
                  size="sm"
                  disabled={pending}
                  onClick={() => run(removeDemoCrmAction)}
                  aria-label="Yes, remove the demo CRM"
                >
                  Remove
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => setConfirming(true)}
              >
                Remove the demo CRM
              </Button>
            ))}
        </div>
      </div>
    </div>
  );
}
