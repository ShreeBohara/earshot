"use client";

import { Button } from "@earshot/ui/components/button";
import { EarIcon } from "lucide-react";
import { useId, useState } from "react";
import { WITNESS_COPY, type WitnessSetting } from "@/lib/capture/witness";
import { CaptureLink } from "./link";

/**
 * The second witness's one-time question (Phase 4 spec decision 8): asked once per device, only
 * when a Groq key is on it, with "yes" preselected. Nothing is sent to Groq until it's answered;
 * Settings → Capture changes the answer later.
 */
export function WitnessPrompt({ onAnswer }: { onAnswer: (setting: WitnessSetting) => void }) {
  const titleId = useId();
  const [choice, setChoice] = useState<WitnessSetting>("groq");
  return (
    <form
      aria-labelledby={titleId}
      data-slot="witness-prompt"
      className="grid gap-3 rounded-lg border border-dashed p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer(choice);
      }}
    >
      <div className="flex gap-3">
        <EarIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="grid gap-1">
          <h3 id={titleId} className="font-medium text-sm">
            Check names with a second witness?
          </h3>
          <p className="max-w-prose text-pretty text-muted-foreground text-sm">
            {WITNESS_COPY.line} {WITNESS_COPY.how}
          </p>
          <p className="max-w-prose text-pretty text-muted-foreground text-sm">
            {WITNESS_COPY.privacy} You can change this in{" "}
            <CaptureLink
              href="/settings/capture"
              className="rounded-sm underline underline-offset-4 outline-none hover:text-foreground focus-visible:focus-ring"
            >
              Settings → Capture
            </CaptureLink>
            .
          </p>
        </div>
      </div>
      <fieldset className="grid gap-2 pl-7">
        <legend className="sr-only">{WITNESS_COPY.name}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="witness-answer"
            value="groq"
            checked={choice === "groq"}
            onChange={() => setChoice("groq")}
            className="size-4 accent-foreground"
          />
          Yes, use Groq Whisper on this device
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="witness-answer"
            value="off"
            checked={choice === "off"}
            onChange={() => setChoice("off")}
            className="size-4 accent-foreground"
          />
          No, leave it off
        </label>
      </fieldset>
      <div className="pl-7">
        <Button type="submit" size="sm" variant="outline">
          Save choice
        </Button>
      </div>
    </form>
  );
}
