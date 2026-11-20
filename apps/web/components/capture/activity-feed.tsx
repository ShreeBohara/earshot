import { cn } from "@earshot/ui/lib/utils";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  LoaderCircleIcon,
  type LucideIcon,
  PlayIcon,
  WifiIcon,
} from "lucide-react";
import { useId } from "react";
import type { ActivityKind, ActivityRow } from "@/lib/capture/activity";

// Each row type has its own icon and a spoken label, so color is never the only cue.
const KINDS: Record<ActivityKind, { label: string; icon: LucideIcon; tone: string }> = {
  action: { label: "Action", icon: PlayIcon, tone: "text-muted-foreground" },
  response: { label: "Response", icon: CircleCheckIcon, tone: "text-state-synced-text" },
  error: { label: "Error", icon: CircleAlertIcon, tone: "text-state-failed-text" },
  connection: { label: "Connection", icon: WifiIcon, tone: "text-state-conflict-text" },
};

/**
 * What the agent is doing, as typed rows: actions, responses, errors, and connection changes.
 * The "Working…" row is transient: the next one replaces it, and the turn's answer removes it.
 * Not a live region: the transcript is the one that speaks, and errors that stop capture raise
 * an alert of their own.
 */
export function ActivityFeed({
  rows,
  className,
}: {
  rows: readonly ActivityRow[];
  className?: string;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cn("flex flex-col gap-3", className)}>
      <h2 id={headingId} className="font-medium text-sm">
        Activity
      </h2>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing yet.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {rows.map((row) => {
            const kind = KINDS[row.kind];
            const Icon = row.transient ? LoaderCircleIcon : kind.icon;
            return (
              <li key={row.id} data-kind={row.kind} className="flex items-start gap-2 text-sm">
                <Icon
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    kind.tone,
                    row.transient && "animate-spin motion-reduce:animate-none",
                  )}
                />
                <span className="min-w-0 text-pretty">
                  <span className="sr-only">{kind.label}: </span>
                  {row.text}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
