"use client";

import { Button } from "@earshot/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@earshot/ui/components/dialog";
import { Field, FieldDescription, FieldLabel } from "@earshot/ui/components/field";
import { Input } from "@earshot/ui/components/input";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { authClient, describeAuthError } from "@/lib/auth/client";
import { clearBrowserClips } from "@/lib/evidence/browser";
import { REAUTH_HREF, ReauthNote } from "./reauth-note";

const NOT_FRESH = new Set(["SESSION_NOT_FRESH", "SESSION_EXPIRED"]);

/**
 * Deletes the account after a typed confirmation: the user types their email. Better Auth checks
 * that the sign-in is recent; the server deletes the user's workspaces first, then the user.
 */
export function DeleteAccount({
  email,
  workspaceName,
  fresh,
}: {
  email: string;
  workspaceName: string;
  fresh: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; reauth: boolean } | null>(null);
  const confirmed = typed.trim().toLowerCase() === email.toLowerCase();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed) return;
    setPending(true);
    setError(null);
    const { error: failure } = await authClient.deleteUser();
    if (failure) {
      setPending(false);
      const reauth = NOT_FRESH.has(failure.code ?? "");
      setError({
        message: reauth
          ? "Your sign-in is more than an hour old. Sign in again, then delete your account."
          : describeAuthError(failure, "Your account wasn't deleted. Try again."),
        reauth,
      });
      return;
    }
    // The account is gone: so is its debriefs' audio on this device (Phase 5 WP9).
    await clearBrowserClips();
    window.location.assign("/?deleted=1");
  }

  if (!fresh) {
    return <ReauthNote>Deleting your account needs a sign-in from the last hour.</ReauthNote>;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setTyped("");
          setError(null);
        }
      }}
    >
      <div>
        <DialogTrigger render={<Button variant="destructive" />}>Delete account…</DialogTrigger>
      </div>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Delete your account?</DialogTitle>
            <DialogDescription>
              This permanently deletes your account, the workspace “{workspaceName}”, and everything
              in it: sessions, transcripts, proposals, and stored keys. It can&apos;t be undone.
              Download your data first if you want a copy.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel>Type your email to confirm</FieldLabel>
            <Input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="h-9"
            />
            <FieldDescription>{email}</FieldDescription>
          </Field>
          {error && (
            <div role="alert" className="flex flex-col gap-2 text-destructive text-sm">
              <p>{error.message}</p>
              {error.reauth && (
                <Link href={REAUTH_HREF} className="w-fit underline underline-offset-4">
                  Sign in again
                </Link>
              )}
            </div>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" variant="destructive" disabled={!confirmed || pending}>
              {pending ? "Deleting…" : "Delete account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
