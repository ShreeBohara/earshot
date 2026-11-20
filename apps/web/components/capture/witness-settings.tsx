"use client";

import type { StoredKeyMeta } from "@earshot/keys";
import { useEffect, useId, useState } from "react";
import { browserDeviceKeys } from "@/lib/capture/keys";
import { hasGroqKey, WITNESS_COPY, type WitnessSetting } from "@/lib/capture/witness";
import { CaptureLink } from "./link";
import { useWitnessSetting } from "./use-witness-setting";

type Keys =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly keys: readonly StoredKeyMeta[] };

/**
 * Settings → Capture's "Second witness" (Phase 4 spec WP9 step 4): off, or Groq Whisper on this
 * device's Groq key. It's the same answer the capture screen's one-time question records, per
 * device. Without a Groq key here, Groq Whisper can't be picked.
 */
export function WitnessSettings() {
  const [setting, save] = useWitnessSetting();
  const [keys, setKeys] = useState<Keys>({ status: "loading" });
  const [saved, setSaved] = useState(false);
  const descriptionId = useId();

  useEffect(() => {
    let cancelled = false;
    browserDeviceKeys()
      .list()
      .then(
        (list) => !cancelled && setKeys({ status: "ready", keys: list }),
        () => !cancelled && setKeys({ status: "unavailable" }),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  const groq = keys.status === "ready" && hasGroqKey(keys.keys);
  // Unanswered reads as off: nothing goes to Groq without a yes.
  const current: WitnessSetting = setting ?? "off";
  const choose = (next: WitnessSetting) => {
    save(next);
    setSaved(true);
  };
  const option = (value: WitnessSetting, label: string, disabled = false) => (
    <label
      className="flex items-center gap-2 text-sm data-[disabled]:text-muted-foreground"
      data-disabled={disabled ? "" : undefined}
    >
      <input
        type="radio"
        name="second-witness"
        value={value}
        checked={current === value}
        disabled={disabled}
        onChange={() => choose(value)}
        className="size-4 accent-foreground"
      />
      {label}
    </label>
  );

  return (
    <fieldset className="grid gap-3" aria-describedby={descriptionId}>
      <legend className="sr-only">{WITNESS_COPY.name}</legend>
      <p id={descriptionId} className="max-w-prose text-pretty text-muted-foreground text-sm">
        {WITNESS_COPY.line}
      </p>
      <div className="grid gap-2">
        {option("off", WITNESS_COPY.options.off)}
        {option("groq", WITNESS_COPY.options.groq, !groq && current !== "groq")}
      </div>
      {keys.status === "ready" && !groq ? (
        <p className="max-w-prose text-pretty text-muted-foreground text-sm">
          {current === "groq"
            ? "It’s on, but this device has no Groq key, so debriefs here run without it. "
            : "It needs a Groq key on this device. "}
          <CaptureLink
            href="/settings/keys"
            className="rounded-sm underline underline-offset-4 outline-none hover:text-foreground focus-visible:focus-ring"
          >
            Add one in Settings → Keys
          </CaptureLink>
          .
        </p>
      ) : null}
      {keys.status === "unavailable" ? (
        <p className="text-muted-foreground text-sm">
          This browser can’t read the keys on this device, so the witness stays off here.
        </p>
      ) : null}
      <p className="max-w-prose text-pretty text-muted-foreground text-sm">
        {WITNESS_COPY.how} {WITNESS_COPY.privacy}
      </p>
      <p aria-live="polite" className="text-muted-foreground text-sm">
        {saved ? "Saved on this device." : ""}
      </p>
    </fieldset>
  );
}
