"use client";

import { Button } from "@earshot/ui/components/button";
import { inputClassName } from "@earshot/ui/components/input";
import { Label } from "@earshot/ui/components/label";
import { cn } from "@earshot/ui/lib/utils";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { cleanKeyLabel, DEFAULT_KEY_LABEL, MAX_KEY_LABEL_LENGTH } from "@/lib/keys/labels";
import { describeProblem } from "@/lib/keys/reasons";

/** A provider the form offers. */
export type ProviderOption = { id: string; name: string; use: string };

/** What the form hands over on submit. `key` is the only copy: use it, then let it go. */
export type AddKeyValues = { provider: string; label: string; key: string };

/** How a submit ended, for the form's status line. */
export type AddKeyOutcome = { ok: true; message: string } | { ok: false; message: string };

type Status =
  | { kind: "idle" }
  | { kind: "working"; message: string }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

/**
 * Pick a provider, name the key, paste it, submit. The key field is a plain, uncontrolled
 * password input: its value is read once on submit and the field is cleared straight away, so
 * the key never sits in React state or in the page once the request is under way. The label is
 * uncontrolled too, in case a key is pasted there by mistake; a label shaped like a key is
 * refused and cleared.
 */
export function AddKeyForm({
  providers,
  submitLabel,
  replaceLabel,
  workingLabel,
  keyHint,
  existing = [],
  extraFields,
  onSubmit,
}: {
  providers: readonly ProviderOption[];
  /** The button, for example "Check and save". */
  submitLabel: string;
  /** The button when the provider and label name a key that's already stored. */
  replaceLabel: string;
  /** The status while working, given the provider's name. */
  workingLabel: (providerName: string) => string;
  /** The key field's description, given the provider's name. */
  keyHint: (providerName: string) => string;
  /** Slots that already hold a key, to warn before replacing one. */
  existing?: ReadonlyArray<{ provider: string; label: string }>;
  /** More fields, such as a checkbox; the submitted form's data reaches `onSubmit`. */
  extraFields?: ReactNode;
  onSubmit: (values: AddKeyValues, form: FormData) => Promise<AddKeyOutcome>;
}) {
  const id = useId();
  const keyRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const [provider, setProvider] = useState(providers[0]?.id ?? "");
  const [replaces, setReplaces] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const providerName = providers.find((p) => p.id === provider)?.name ?? "the provider";

  // Only whether the slot is taken is kept, never the label text itself.
  function updateReplaces(nextProvider = provider) {
    const label = labelRef.current?.value.trim() || DEFAULT_KEY_LABEL;
    setReplaces(existing.some((slot) => slot.provider === nextProvider && slot.label === label));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const keyInput = keyRef.current;
    const labelInput = labelRef.current;
    const key = keyInput?.value.trim() ?? "";
    // The key leaves the page here: it lives on only in this function until the request ends.
    if (keyInput) keyInput.value = "";
    if (!key) {
      setStatus({ kind: "error", message: describeProblem("missing_key").message });
      keyInput?.focus();
      return;
    }
    const label = cleanKeyLabel(labelInput?.value || DEFAULT_KEY_LABEL, key);
    if (!label) {
      // It might be a key pasted into the wrong field, so don't leave it on the page either.
      if (labelInput) labelInput.value = "";
      setStatus({ kind: "error", message: describeProblem("invalid_label").message });
      labelInput?.focus();
      return;
    }

    setPending(true);
    setStatus({ kind: "working", message: workingLabel(providerName) });
    const outcome = await onSubmit({ provider, label, key }, new FormData(event.currentTarget));
    setPending(false);
    if (outcome.ok) {
      if (labelInput) labelInput.value = DEFAULT_KEY_LABEL;
      setReplaces(false);
      setStatus({ kind: "done", message: outcome.message });
    } else {
      setStatus({ kind: "error", message: outcome.message });
      keyInput?.focus();
    }
  }

  const control = cn(inputClassName, "h-9");
  return (
    <form onSubmit={submit} noValidate className="grid max-w-xl gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-2">
          <Label htmlFor={`${id}-provider`}>Provider</Label>
          <select
            id={`${id}-provider`}
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value);
              updateReplaces(event.target.value);
            }}
            className={control}
          >
            {providers.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name} ({option.use})
              </option>
            ))}
          </select>
        </div>
        <div className="grid content-start gap-2">
          <Label htmlFor={`${id}-label`}>Label</Label>
          <input
            ref={labelRef}
            id={`${id}-label`}
            defaultValue={DEFAULT_KEY_LABEL}
            maxLength={MAX_KEY_LABEL_LENGTH}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-label-hint`}
            onChange={() => updateReplaces()}
            className={control}
          />
          <p id={`${id}-label-hint`} className="text-muted-foreground text-sm">
            Tells keys apart, like “work”. It&apos;s shown in plain text, so never put a key here.
          </p>
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-key`}>Key</Label>
        <input
          ref={keyRef}
          id={`${id}-key`}
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-describedby={`${id}-key-hint`}
          className={cn(control, "font-mono")}
        />
        <p id={`${id}-key-hint`} className="text-muted-foreground text-sm">
          {keyHint(providerName)}
        </p>
      </div>
      {extraFields}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Checking…" : replaces ? replaceLabel : submitLabel}
        </Button>
        <p role="status" className="text-muted-foreground text-sm">
          {status.kind === "working" || status.kind === "done" ? status.message : ""}
        </p>
      </div>
      {status.kind === "error" && (
        <p role="alert" className="text-destructive text-sm">
          {status.message}
        </p>
      )}
    </form>
  );
}
