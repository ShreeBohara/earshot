"use client";

import { Button } from "@earshot/ui/components/button";
import { Field, FieldLabel, FieldSeparator } from "@earshot/ui/components/field";
import { Input } from "@earshot/ui/components/input";
import { CircleAlertIcon, KeyRoundIcon, MailCheckIcon } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { GitHubMark, GoogleMark } from "@/components/brand-icons";
import { authClient, describeAuthError } from "@/lib/auth/client";
import type { SocialProviderId } from "@/lib/auth/config";
import { ONBOARDING_PATH } from "@/lib/auth/redirects";

const PROVIDERS: Record<SocialProviderId, { label: string; Mark: typeof GitHubMark }> = {
  github: { label: "GitHub", Mark: GitHubMark },
  google: { label: "Google", Mark: GoogleMark },
};

type Pending = null | "email" | "passkey" | SocialProviderId;

export function SignInForm({
  next,
  providers,
  initialError,
  devMailHint,
}: {
  /** Where to go after signing in. Already sanitized by the page. */
  next: string;
  /** OAuth providers this server configures, decided on the server. */
  providers: SocialProviderId[];
  initialError: string | null;
  /** `next dev` without an email provider: links go to the terminal. */
  devMailHint: boolean;
}) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [resent, setResent] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const sentHeading = useRef<HTMLHeadingElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const errorCallbackURL = `/sign-in?next=${encodeURIComponent(next)}`;

  // Move focus with the view, so keyboard and screen-reader users land on the new content.
  useEffect(() => {
    if (sentTo) sentHeading.current?.focus();
  }, [sentTo]);

  async function sendLink(address: string) {
    setError(null);
    setResent(false);
    setPending("email");
    const { error: failure } = await authClient.signIn.magicLink({
      email: address,
      callbackURL: next,
      newUserCallbackURL: ONBOARDING_PATH,
      errorCallbackURL,
    });
    setPending(null);
    if (failure) {
      setError(describeAuthError(failure, "We couldn't send the link. Try again."));
      return;
    }
    setResent(sentTo === address);
    setSentTo(address);
  }

  async function onEmailSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendLink(email.trim());
  }

  async function signInWithPasskey() {
    setError(null);
    setPending("passkey");
    const result = await authClient.signIn.passkey();
    if (result?.error) {
      setPending(null);
      setError(describeAuthError(result.error, "Passkey sign-in didn't work. Try email instead."));
      return;
    }
    // A full navigation, so every server component renders for the new session.
    window.location.assign(next);
  }

  async function signInWithProvider(provider: SocialProviderId) {
    setError(null);
    setPending(provider);
    const { error: failure } = await authClient.signIn.social({
      provider,
      callbackURL: next,
      newUserCallbackURL: ONBOARDING_PATH,
      errorCallbackURL,
    });
    // On success the browser is already on its way to the provider.
    if (failure) {
      setPending(null);
      setError(describeAuthError(failure));
    }
  }

  if (sentTo) {
    return (
      <section aria-labelledby="sent-heading" className="flex flex-col gap-4">
        <MailCheckIcon aria-hidden="true" className="size-6 text-state-synced" />
        <h2
          id="sent-heading"
          ref={sentHeading}
          tabIndex={-1}
          className="font-serif text-3xl tracking-tight outline-none"
        >
          Check your email
        </h2>
        <p className="text-pretty">
          We sent a sign-in link to <span className="font-medium wrap-anywhere">{sentTo}</span>. It
          works once and expires in 5 minutes.
        </p>
        {devMailHint && (
          <p className="rounded-lg border border-dashed px-3 py-2 font-mono text-muted-foreground text-xs">
            Development: no email provider is set, so the link is printed in the terminal running
            pnpm dev.
          </p>
        )}
        <p className="text-muted-foreground text-sm">
          Can&apos;t find it? Check your spam folder, or send another.
        </p>
        <p role="status" className="text-sm empty:hidden">
          {resent ? "We sent another link." : ""}
        </p>
        {error && <ErrorNotice message={error} />}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setSentTo(null);
              setError(null);
              requestAnimationFrame(() => emailInput.current?.focus());
            }}
          >
            Use a different email
          </Button>
          <Button variant="ghost" disabled={pending !== null} onClick={() => sendLink(sentTo)}>
            {pending === "email" ? "Sending…" : "Send another link"}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {error && <ErrorNotice message={error} />}

      <form onSubmit={onEmailSubmit} className="flex flex-col gap-3">
        <Field>
          <FieldLabel>Email</FieldLabel>
          <Input
            ref={emailInput}
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            className="h-9"
          />
        </Field>
        <Button type="submit" size="lg" disabled={pending !== null}>
          {pending === "email" ? "Sending…" : "Email me a sign-in link"}
        </Button>
      </form>

      <FieldSeparator>or</FieldSeparator>

      <div className="flex flex-col gap-2">
        <Button variant="outline" size="lg" disabled={pending !== null} onClick={signInWithPasskey}>
          <KeyRoundIcon aria-hidden="true" />
          {pending === "passkey" ? "Waiting for your passkey…" : "Sign in with a passkey"}
        </Button>
        {providers.map((provider) => {
          const { label, Mark } = PROVIDERS[provider];
          return (
            <Button
              key={provider}
              variant="outline"
              size="lg"
              disabled={pending !== null}
              onClick={() => signInWithProvider(provider)}
            >
              <Mark className="size-4" />
              {pending === provider ? `Opening ${label}…` : `Continue with ${label}`}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-state-failed-border bg-state-failed-bg px-3 py-2 text-sm text-state-failed-text"
    >
      <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p>{message}</p>
    </div>
  );
}
