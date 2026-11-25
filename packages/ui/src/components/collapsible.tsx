"use client";

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import { cn } from "cn";

// A disclosure on Base UI's Collapsible (Phase 5 WP10: the recap's lens, and each recap sentence's
// evidence): the trigger is a real button with `aria-expanded` and `aria-controls`, toggled by a
// click, Enter, or Space, and the panel is hidden from everyone while closed. Collapsed unless
// `defaultOpen` says otherwise. The trigger's own text names it; style it for at least 24px.

function Collapsible({ className, ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" className={className} {...props} />;
}

function CollapsibleTrigger({ className, ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn(
        "group/collapsible inline-flex min-h-6 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function CollapsiblePanel({ className, ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-panel"
      className={cn("[&[hidden]:not([hidden='until-found'])]:hidden", className)}
      {...props}
    />
  );
}

export { Collapsible, CollapsiblePanel, CollapsibleTrigger };
