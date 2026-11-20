"use client";

import { Kbd } from "@earshot/ui/components/kbd";
import { RadioGroup, RadioGroupItem } from "@earshot/ui/components/radio-group";
import { cn } from "@earshot/ui/lib/utils";
import { type Ref, useId } from "react";
import type { ChoiceOption } from "@/lib/inbox/card";

/**
 * Numbered choices as a radio group (spec WP5 step 3): a question's records, a field's two
 * readings, or the correction panel's records. Each radio is named by its label and detail ("Dana
 * Li, Akme Dynamics 48%"), and the group by `label`. Picking one with the pointer or the arrow keys
 * only selects it; a digit (while the shortcuts are on) or the card's Accept decides.
 */
export function ChoiceList({
  label,
  options,
  value,
  shortcuts,
  onSelect,
  groupRef,
  className,
}: {
  label: string;
  options: readonly ChoiceOption[];
  value: number | null;
  shortcuts: boolean;
  onSelect: (index: number) => void;
  groupRef?: Ref<HTMLDivElement>;
  className?: string;
}) {
  const labelId = useId();
  return (
    <div className={cn("grid gap-1.5", className)}>
      <p id={labelId} className="font-medium text-muted-foreground text-xs">
        {label}
      </p>
      <RadioGroup
        ref={groupRef}
        aria-labelledby={labelId}
        value={value === null ? null : String(value)}
        onValueChange={(next) => onSelect(Number(next))}
        className="grid gap-1.5 sm:grid-cols-2"
      >
        {options.map((option, index) => (
          <label
            key={option.kind === "record" ? (option.entityId ?? "new") : `${option.field}:${index}`}
            className="flex min-h-9 cursor-default items-center gap-2.5 rounded-lg border px-3 py-1.5 text-sm transition-colors hover:bg-muted/60 has-data-checked:border-primary has-data-checked:bg-muted motion-reduce:transition-none"
          >
            <RadioGroupItem value={String(index)} />
            {shortcuts ? <Kbd className="shrink-0">{index + 1}</Kbd> : null}
            <span className="min-w-0 flex-1 text-pretty">{option.label}</span>
            <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
              {option.detail}
            </span>
          </label>
        ))}
      </RadioGroup>
    </div>
  );
}
