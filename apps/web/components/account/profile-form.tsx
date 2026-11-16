"use client";

import { Button } from "@earshot/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@earshot/ui/components/field";
import { Input } from "@earshot/ui/components/input";
import { useActionState } from "react";
import { type ActionResult, updateProfile } from "@/app/(app)/settings/account/actions";
import { MAX_NAME_LENGTH } from "@/lib/account/constants";

const IDLE: ActionResult = { status: "idle" };

export function ProfileForm({
  name,
  email,
  memberSince,
}: {
  name: string;
  email: string;
  memberSince: string;
}) {
  const [state, action, pending] = useActionState(updateProfile, IDLE);

  return (
    <form action={action} className="flex max-w-md flex-col gap-5">
      <Field>
        <FieldLabel>Name</FieldLabel>
        <Input
          name="name"
          defaultValue={name}
          maxLength={MAX_NAME_LENGTH}
          autoComplete="name"
          className="h-9"
        />
        <FieldDescription>
          Shown in the header and next to the changes you approve.
        </FieldDescription>
      </Field>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Email</dt>
        <dd className="wrap-anywhere">{email}</dd>
        <dt className="text-muted-foreground">Member since</dt>
        <dd>{memberSince}</dd>
      </dl>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <p
          role="status"
          className={
            state.status === "error" ? "text-destructive text-sm" : "text-muted-foreground text-sm"
          }
        >
          {pending ? "" : (state.message ?? "")}
        </p>
      </div>
    </form>
  );
}
