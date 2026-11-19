import { cn } from "@earshot/ui/lib/utils";
import { formatUsd } from "@earshot/voice/prices";

/**
 * What the debrief costs on the rep's own keys: a running total from SessionDO's meter while it
 * runs, then the final figure ("This debrief cost $0.011").
 */
export function CostMeter({
  costUsd,
  final,
  className,
}: {
  costUsd: number;
  final: boolean;
  className?: string;
}) {
  if (final) {
    return (
      <p data-slot="cost" data-final="" className={cn("text-sm", className)}>
        This debrief cost{" "}
        <span className="font-medium font-mono tabular-nums">{formatUsd(costUsd)}</span>
      </p>
    );
  }
  return (
    <p data-slot="cost" className={cn("text-muted-foreground text-sm", className)}>
      Cost so far{" "}
      <span className="font-mono text-foreground tabular-nums">{formatUsd(costUsd)}</span>
    </p>
  );
}
