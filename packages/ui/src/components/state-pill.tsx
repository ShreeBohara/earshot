import { Badge } from "@earshot/ui/components/badge";
import { cn } from "cn";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  CircleXIcon,
  type LucideIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type * as React from "react";

type StatePillState = "proposed" | "conflict" | "synced" | "failed" | "neutral";

// Each state has a label and a shape, so color is never the only cue (WCAG 1.4.1).
const STATES: Record<StatePillState, { label: string; icon: LucideIcon }> = {
  proposed: { label: "Proposed", icon: CircleDashedIcon },
  conflict: { label: "Conflict", icon: TriangleAlertIcon },
  synced: { label: "Synced", icon: CircleCheckIcon },
  failed: { label: "Failed", icon: CircleXIcon },
  neutral: { label: "Unchanged", icon: CircleIcon },
};

type StatePillProps = Omit<React.ComponentProps<typeof Badge>, "variant"> & {
  /** Which state the pill shows. Picks the color, the icon, and the default label. */
  state: StatePillState;
  /** Hide the icon, for dense layouts. The label stays. */
  hideIcon?: boolean;
};

/**
 * Earshot's state language: proposed (blue), conflict (amber), synced (green), failed (red),
 * and neutral. Server-component safe; pass `render` to make it a trigger, for example the
 * button that opens a conflict's alternatives.
 */
function StatePill({ state, hideIcon = false, className, children, ...props }: StatePillProps) {
  const { label, icon: Icon } = STATES[state];

  return (
    <Badge
      data-slot="state-pill"
      data-state={state}
      variant={state}
      className={cn("h-6 gap-1.5 px-2.5", className)}
      {...props}
    >
      {hideIcon ? null : <Icon aria-hidden="true" data-icon="inline-start" />}
      {children ?? label}
    </Badge>
  );
}

export { StatePill, type StatePillProps, type StatePillState };
