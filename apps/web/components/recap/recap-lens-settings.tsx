"use client";

import { RECAP_LENS_LIST } from "@earshot/agent/recap/lenses";
import type { RecapLensId } from "@earshot/core";
import { useId, useState } from "react";
import { LENS_COPY } from "@/lib/recap/copy";
import { useRecapLens } from "./use-recap-lens";

/**
 * Settings → Capture's "Recap lens" (Phase 5 spec WP10 step 3): none, MEDDIC, SPICED, or BANT, per
 * device, sent with each debrief's `end`. The recap maps each of the lens's fields to the rep's own
 * words, or "not mentioned", and shows it collapsed under the recap.
 */
export function RecapLensSettings() {
  const [lens, save] = useRecapLens();
  const [saved, setSaved] = useState("");
  const descriptionId = useId();
  const choose = (next: RecapLensId | null) => {
    save(next);
    const label = next ? RECAP_LENS_LIST.find((item) => item.id === next)?.label : LENS_COPY.none;
    setSaved(`Saved on this device: ${label ?? next ?? LENS_COPY.none}.`);
  };
  const option = (value: RecapLensId | null, label: string, detail: string | null) => (
    <label key={value ?? "none"} className="flex items-start gap-2 text-sm">
      <input
        type="radio"
        name="recap-lens"
        value={value ?? "none"}
        checked={lens === value}
        onChange={() => choose(value)}
        className="mt-0.5 size-4 accent-foreground"
      />
      <span className="grid gap-0.5">
        <span>{label}</span>
        {detail ? <span className="text-muted-foreground text-xs">{detail}</span> : null}
      </span>
    </label>
  );
  return (
    <fieldset className="grid gap-3" aria-describedby={descriptionId}>
      <legend className="sr-only">{LENS_COPY.name}</legend>
      <p id={descriptionId} className="max-w-prose text-pretty text-muted-foreground text-sm">
        {LENS_COPY.line}
      </p>
      <div className="grid gap-2">
        {option(null, LENS_COPY.none, null)}
        {RECAP_LENS_LIST.map((item) =>
          option(item.id, item.label, item.fields.map((field) => field.label).join(", ")),
        )}
      </div>
      <p aria-live="polite" className="text-muted-foreground text-sm">
        {saved}
      </p>
    </fieldset>
  );
}
