"use client";

import { Button } from "@earshot/ui/components/button";
import { toast } from "@earshot/ui/components/toast";
import { useTransition } from "react";
import { loadSampleDebriefsAction } from "@/app/actions/samples";

/** Settings → Data: loads the sample debriefs, sealed and ready to review. */
export function SampleDebriefs() {
  const [pending, startTransition] = useTransition();

  function load() {
    startTransition(async () => {
      const result = await loadSampleDebriefsAction();
      toast.add({ title: result.message, type: result.status === "error" ? "error" : "success" });
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3">
      <p className="min-w-0 flex-1 text-muted-foreground text-sm">
        Two recorded debriefs, already finished, whose proposals wait for your review. Load the demo
        CRM first, so their records link to it.
      </p>
      <Button variant="outline" size="sm" disabled={pending} onClick={load}>
        {pending ? "Loading…" : "Load sample debriefs"}
      </Button>
    </div>
  );
}
