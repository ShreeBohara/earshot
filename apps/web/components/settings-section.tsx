import { cn } from "@earshot/ui/lib/utils";
import type { ReactNode } from "react";

/** One titled block of a settings page, separated from the next by a rule. */
export function SettingsSection({
  id,
  title,
  description,
  tone = "default",
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  tone?: "default" | "danger";
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="grid gap-4 border-t pt-8">
      <div className="flex flex-col gap-1">
        <h2
          id={id}
          className={cn("font-medium text-base", tone === "danger" && "text-destructive")}
        >
          {title}
        </h2>
        {description && (
          <p className="max-w-prose text-pretty text-muted-foreground text-sm">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}
