"use client";

import type { FieldValue } from "@earshot/core";
import { Button } from "@earshot/ui/components/button";
import { Input, inputClassName } from "@earshot/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@earshot/ui/components/radio-group";
import { cn } from "@earshot/ui/lib/utils";
import {
  type FormEvent,
  type KeyboardEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { fieldLabel } from "@/lib/capture/copy";
import { shownValue } from "@/lib/inbox/copy";
import { DATE_FIELDS, type EditDraft, readEdit } from "@/lib/inbox/edit";
import type { InputEventLike } from "@/lib/inbox/input";
import type { InboxProposal } from "@/lib/inbox/types";

/** Fields long enough to want a few lines. */
const LONG_FIELDS = new Set(["body", "text"]);

/**
 * The inline editor (spec WP5 step 5): each field as a labeled input, an ambiguous date's readings
 * as radio choices (Base UI has no date picker), errors tied to their fields. Enter saves as
 * `edited`, Esc cancels, and the page returns focus to the card either way.
 */
export function EditForm({
  proposal,
  quotes,
  onSave,
  onCancel,
}: {
  proposal: InboxProposal;
  quotes: Readonly<Record<string, string>>;
  /** With how it was saved: Enter in a field (the keyboard), or the button's own input. */
  onSave: (values: Readonly<Record<string, FieldValue>>, event: InputEventLike) => void;
  onCancel: () => void;
}) {
  const formId = useId();
  const fields = Object.entries(proposal.fields);
  const [draft, setDraft] = useState<EditDraft>(() =>
    Object.fromEntries(
      fields.map(([name, field]) => [name, field.value === null ? "" : String(field.value)]),
    ),
  );
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const first = useRef<HTMLElement | null>(null);
  /** The click on "Save and accept", when that's what submitted; Enter otherwise. */
  const via = useRef<InputEventLike | null>(null);

  // Into the first field as the editor opens.
  useLayoutEffect(() => {
    first.current?.focus();
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    const how = via.current ?? { type: "keydown" };
    via.current = null;
    const result = readEdit(proposal, draft);
    if (!result.ok) {
      setErrors(result.errors);
      setFormError(result.formError);
      const firstBad = Object.keys(result.errors)[0];
      const target = firstBad
        ? document.getElementById(`${formId}-${firstBad}`)
        : (first.current as HTMLElement | null);
      target?.focus();
      return;
    }
    onSave(result.values, how);
  }

  function keyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  }

  const formErrorId = `${formId}-form-error`;
  return (
    <form
      data-inbox-editor=""
      aria-label="Edit the proposal"
      noValidate
      onSubmit={submit}
      onKeyDown={keyDown}
      className="grid gap-3 rounded-lg border border-dashed p-3"
    >
      {fields.map(([name, field], index) => {
        const id = `${formId}-${name}`;
        const errorId = `${id}-error`;
        const heardId = `${id}-heard`;
        const error = errors[name];
        const heard = quotes[field.evidence.utteranceId]?.slice(
          field.evidence.span[0],
          field.evidence.span[1],
        );
        const describedBy = [
          heard ? heardId : null,
          error ? errorId : null,
          index === 0 && formError ? formErrorId : null,
        ]
          .filter(Boolean)
          .join(" ");
        const readings = field.norm?.readings ?? [];
        const setValue = (value: string) => setDraft((current) => ({ ...current, [name]: value }));
        const ref =
          index === 0
            ? (element: HTMLElement | null) => {
                first.current = element;
              }
            : undefined;
        return (
          <div key={name} className="grid gap-1.5">
            {readings.length > 1 ? (
              <>
                <p id={`${id}-label`} className="font-medium text-sm">
                  {fieldLabel(name)}
                </p>
                <RadioGroup
                  ref={ref as ((element: HTMLDivElement | null) => void) | undefined}
                  id={id}
                  aria-labelledby={`${id}-label`}
                  aria-describedby={describedBy || undefined}
                  value={draft[name] ?? ""}
                  onValueChange={(next) => setValue(String(next))}
                  className="flex flex-wrap gap-2"
                >
                  {readings.map((reading) => (
                    <label
                      key={String(reading)}
                      className="flex min-h-8 items-center gap-2 rounded-lg border px-3 py-1 text-sm has-data-checked:border-primary has-data-checked:bg-muted"
                    >
                      <RadioGroupItem value={String(reading)} />
                      {shownValue(name, reading, field.norm?.currency)}
                    </label>
                  ))}
                </RadioGroup>
              </>
            ) : (
              <>
                <label htmlFor={id} className="font-medium text-sm">
                  {fieldLabel(name)}
                </label>
                {LONG_FIELDS.has(name) ? (
                  <textarea
                    ref={ref as ((element: HTMLTextAreaElement | null) => void) | undefined}
                    id={id}
                    value={draft[name] ?? ""}
                    onChange={(event) => setValue(event.target.value)}
                    onKeyDown={(event) => {
                      // Enter saves, as in every other field; Shift+Enter starts a new line.
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    rows={2}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy || undefined}
                    className={cn(inputClassName, "h-auto min-h-16 resize-y py-1.5")}
                  />
                ) : (
                  <Input
                    ref={ref as ((element: HTMLInputElement | null) => void) | undefined}
                    id={id}
                    type={inputType(name)}
                    inputMode={typeof field.value === "number" ? "decimal" : undefined}
                    value={draft[name] ?? ""}
                    onChange={(event) => setValue(event.target.value)}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy || undefined}
                  />
                )}
              </>
            )}
            {heard ? (
              <p id={heardId} className="font-mono text-muted-foreground text-xs">
                Heard: “{heard}”
              </p>
            ) : null}
            {error ? (
              <p id={errorId} className="text-destructive text-xs">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
      {formError ? (
        <p id={formErrorId} className="text-destructive text-xs">
          {formError}
        </p>
      ) : null}
      <p className="text-muted-foreground text-xs">Enter saves and accepts. Esc cancels.</p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          onClick={(event) => {
            via.current = event;
          }}
        >
          Save and accept
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A date or a time gets the browser's own control; numbers and words are text. */
function inputType(name: string): string {
  if (DATE_FIELDS.has(name)) return "date";
  if (name === "time") return "time";
  return "text";
}
