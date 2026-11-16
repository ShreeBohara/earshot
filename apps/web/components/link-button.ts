import { buttonVariants } from "@earshot/ui/components/button";
import { cn } from "@earshot/ui/lib/utils";

/**
 * Button styles for links. `buttonVariants` alone concatenates its classes without merging them,
 * so the base `border-transparent` can beat a variant's border color (outline links lose their
 * border in the light theme). Merging resolves that conflict.
 */
export function linkButton(...args: Parameters<typeof buttonVariants>): string {
  return cn(buttonVariants(...args));
}
