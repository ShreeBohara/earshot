"use client";

import { inputClassName } from "@earshot/ui/components/input";
import { Label } from "@earshot/ui/components/label";
import { cn } from "@earshot/ui/lib/utils";
import { useId } from "react";
import {
  type Choice,
  choiceLabel,
  type LlmOption,
  type ProviderChoices,
  type ProviderSelection,
  type SttOption,
} from "@/lib/capture/providers";
import { CaptureLink } from "./link";

function Picker<O extends SttOption | LlmOption>({
  label,
  choices,
  value,
  onChange,
  disabled,
  empty,
}: {
  label: string;
  choices: readonly Choice<O>[];
  value: string | undefined;
  onChange: (value: string) => void;
  disabled: boolean;
  empty: string;
}) {
  const id = useId();
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {choices.length === 0 ? (
        <p id={id} className="text-muted-foreground text-sm">
          {empty}{" "}
          <CaptureLink
            href="/settings/keys"
            className="font-medium text-foreground underline underline-offset-4"
          >
            Add one in Settings → Keys
          </CaptureLink>
          .
        </p>
      ) : (
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={cn(inputClassName, "h-9")}
        >
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choiceLabel(choice)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/**
 * Which speech-to-text provider and which model a debrief runs on, from the keys on this device.
 * Keys never come near this: only their provider, label, and last four characters.
 */
export function ProviderPickers({
  choices,
  value,
  onChange,
  disabled = false,
}: {
  choices: ProviderChoices;
  value: ProviderSelection | null;
  onChange: (value: ProviderSelection) => void;
  disabled?: boolean;
}) {
  const stt = value?.stt ?? choices.stt[0]?.value;
  const llm = value?.llm ?? choices.llm[0]?.value;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Picker
        label="Speech-to-text"
        choices={choices.stt}
        value={stt}
        disabled={disabled}
        onChange={(next) => llm && onChange({ stt: next, llm })}
        empty="No speech-to-text key on this device."
      />
      <Picker
        label="Model"
        choices={choices.llm}
        value={llm}
        disabled={disabled}
        onChange={(next) => stt && onChange({ stt, llm: next })}
        empty="No model key on this device."
      />
    </div>
  );
}
