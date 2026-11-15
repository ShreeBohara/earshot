"use client";

// The two demos that need client state or event handlers. Everything else on /design renders
// from the server component in page.tsx.

import { Button } from "@earshot/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@earshot/ui/components/field";
import { Input } from "@earshot/ui/components/input";
import { toast } from "@earshot/ui/components/toast";
import { useState } from "react";

export function ApiKeyField() {
  const [value, setValue] = useState("pk-live-1234");
  const invalid = value.length > 0 && !value.startsWith("sk-");

  return (
    <Field invalid={invalid}>
      <FieldLabel>OpenAI API key</FieldLabel>
      <Input value={value} onChange={(event) => setValue(event.target.value)} />
      <FieldDescription>Stays on this device. Earshot never sends it to a server.</FieldDescription>
      {invalid && <FieldError>Keys start with “sk-”.</FieldError>}
    </Field>
  );
}

export function SyncToastButton() {
  return (
    <Button
      onClick={() => {
        const id = toast.add({
          type: "success",
          title: "Synced 3 fields to HubSpot",
          description: "Acme renewal · amount, close date, next step",
          actionProps: {
            children: "Undo",
            onClick: () => {
              toast.close(id);
              toast.add({ title: "Sync undone", description: "HubSpot is back to how it was." });
            },
          },
        });
      }}
    >
      Sync to HubSpot
    </Button>
  );
}
