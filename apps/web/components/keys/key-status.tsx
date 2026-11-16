import { StatePill } from "@earshot/ui/components/state-pill";
import { Loader2Icon } from "lucide-react";
import { describeProblem } from "@/lib/keys/reasons";
import type { KeyProblem } from "@/lib/keys/types";

/** One key's status: the latest thing known about it. */
export type KeyStatus =
  /** It passed a check with its provider, at this ISO time. */
  | { kind: "checked"; at: string }
  | { kind: "unchecked" }
  | { kind: "checking" }
  | { kind: "problem"; problem: KeyProblem; retryAfterSeconds?: number };

/** The status as a pill: a color, a shape, and a word, so color is never the only cue. */
export function KeyStatusPill({ status, provider }: { status: KeyStatus; provider: string }) {
  switch (status.kind) {
    case "checked":
      return <StatePill state="synced">Checked</StatePill>;
    case "unchecked":
      return <StatePill state="neutral">Not checked</StatePill>;
    case "checking":
      return (
        <StatePill state="neutral" hideIcon>
          <Loader2Icon
            aria-hidden="true"
            data-icon="inline-start"
            className="animate-spin motion-reduce:animate-none"
          />
          Checking…
        </StatePill>
      );
    case "problem": {
      const copy = describeProblem(status.problem, {
        provider,
        ...(status.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: status.retryAfterSeconds }),
      });
      return <StatePill state={copy.state}>{copy.pill}</StatePill>;
    }
  }
}
