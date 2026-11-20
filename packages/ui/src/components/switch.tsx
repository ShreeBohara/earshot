"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "cn";

// An on/off switch on Base UI's Switch: role="switch" with aria-checked, toggled by Space or a
// click, and a hidden checkbox for forms. Name it with an enclosing <label>, `aria-labelledby`, or
// a Field's label. The track is 24×40px, at the 24px target minimum.

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-6 w-10 shrink-0 items-center rounded-full border border-transparent bg-input p-0.5 outline-none transition-colors focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50 data-checked:bg-primary motion-reduce:transition-none dark:bg-input/80 dark:data-checked:bg-primary",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-5 rounded-full bg-background shadow-sm ring-0 transition-transform data-checked:translate-x-4 motion-reduce:transition-none rtl:data-checked:-translate-x-4 dark:data-checked:bg-primary-foreground"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
