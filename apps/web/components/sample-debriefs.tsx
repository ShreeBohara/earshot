"use client";

import { Button } from "@earshot/ui/components/button";
import { toast } from "@earshot/ui/components/toast";
import { useTransition } from "react";
import {
  loadFinishingSampleAction,
  loadSampleDebriefsAction,
  type SampleDebriefsResult,
} from "@/app/actions/samples";

/**
 * Settings → Data: loads the sample debriefs, sealed and ready to review. Under `next dev` it also
 * offers a debrief that's still finishing, for the inbox's "Finishing" state.
 */
export function SampleDebriefs({ development = false }: { development?: boolean }) {
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<SampleDebriefsResult>) {
    startTransition(async () => {
      const result = await action();
      toast.add({ title: result.message, type: result.status === "error" ? "error" : "success" });
    });
  }
  const load = () => run(loadSampleDebriefsAction);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3">
      <p className="min-w-0 flex-1 text-muted-foreground text-sm">
        Two recorded debriefs, already finished, whose proposals wait for your review. Load the demo
        CRM first, so their records link to it.
      </p>
      <Button variant="outline" size="sm" disabled={pending} onClick={load}>
        {pending ? "Loading…" : "Load sample debriefs"}
      </Button>
      {development ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => run(loadFinishingSampleAction)}
        >
          Load a finishing debrief (development)
        </Button>
      ) : null}
    </div>
  );
}
