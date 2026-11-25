"use client";

import type { PolicyRouteErrorBody, PolicyRouteResponse, PolicyView } from "@earshot/core";
import { Button } from "@earshot/ui/components/button";
import { Switch } from "@earshot/ui/components/switch";
import { KeyRoundIcon, MailIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { reauthHref } from "@/components/account/reauth-note";
import { When } from "@/components/inbox/inbox-sections";
import { linkButton } from "@/components/link-button";
import { authClient, describeAuthError } from "@/lib/auth/client";
import {
  ALWAYS_REVIEW_COPY,
  choicesFrom,
  POLICY_TYPE_COPY,
  POLICY_TYPES,
  type PolicyChoices,
  rulesFrom,
} from "@/lib/policies/copy";
import type { StepUpState } from "@/lib/policies/types";

const HERE = "/settings/review";

/** Re-renders when `deadline` passes, so the page asks for the step-up again on its own. */
function usePassed(deadline: number): boolean {
  const [passed, setPassed] = useState(() => Date.now() >= deadline);
  useEffect(() => {
    const left = deadline - Date.now();
    setPassed(left <= 0);
    if (left <= 0) return;
    const timer = window.setTimeout(() => setPassed(true), left + 50);
    return () => window.clearTimeout(timer);
  }, [deadline]);
  return passed;
}

/**
 * Settings → Review's approval policy (Phase 5 spec §4.6, WP11 step 4): per proposal type, an
 * "Auto-approve" switch and the fields that always need review, each with an example; the current
 * version, and who changed it when. Saving needs a sign-in from the last 5 minutes: when the
 * viewer's is older, the page offers "Confirm with your passkey", which signs in again with the
 * account's passkey right here, or an email link (and the other sign-in methods) for an account
 * without one. A change applies from the next debrief.
 */
export function ApprovalPolicySettings({
  policy,
  changedBy,
  stepUp,
  email,
  loadedAt,
}: {
  /** The workspace's policy now, or null when it has none. */
  policy: PolicyView | null;
  /** Who changed it, in words ("you"); null without a policy. */
  changedBy: string | null;
  stepUp: StepUpState;
  /** The viewer's address, for the email link that signs them in again. */
  email: string;
  /** When the server read this, ISO 8601. */
  loadedAt: string;
}) {
  const router = useRouter();
  const [choices, setChoices] = useState<PolicyChoices>(() => choicesFrom(policy?.rules ?? null));
  // The version the switches were last saved as, here or on the server: what a save changes from.
  const [saved, setSaved] = useState(() => ({
    rules: policy?.rules ?? null,
    version: policy?.version ?? 0,
  }));
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const [pending, setPending] = useState<null | "save" | "passkey" | "email">(null);
  const [linkSent, setLinkSent] = useState(false);
  const expired = usePassed(Date.parse(stepUp.endsAt));
  const steppedUp = stepUp.steppedUp && !expired && !needsStepUp;
  const headingId = useId();
  const idBase = useId();

  // A new sign-in re-renders the page with a new step-up window: the server decides again.
  useEffect(() => {
    if (stepUp.endsAt) setNeedsStepUp(false);
  }, [stepUp.endsAt]);

  const draft = rulesFrom(choices);
  const dirty = JSON.stringify(draft) !== JSON.stringify(rulesFrom(choicesFrom(saved.rules)));

  const setType = (type: (typeof POLICY_TYPES)[number], on: boolean) =>
    setChoices((current) => ({ ...current, [type]: { ...current[type], on } }));
  const setField = (type: (typeof POLICY_TYPES)[number], field: string, held: boolean) =>
    setChoices((current) => {
      const now = current[type].alwaysReview.filter((name) => name !== field);
      return {
        ...current,
        [type]: { ...current[type], alwaysReview: held ? [...now, field] : now },
      };
    });

  async function save() {
    setError(null);
    setMessage("");
    setPending("save");
    let response: Response;
    try {
      response = await fetch("/api/policies", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rules: draft, baseVersion: saved.version }),
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {
      setPending(null);
      setError("Earshot couldn’t reach the server. Try again.");
      return;
    }
    setPending(null);
    if (response.ok) {
      const body = (await response.json()) as PolicyRouteResponse;
      setSaved({ rules: body.policy.rules, version: body.policy.version });
      setChoices(choicesFrom(body.policy.rules));
      setMessage(
        body.changed
          ? `Saved as version ${body.policy.version}. It applies from your next debrief.`
          : "Nothing changed.",
      );
      router.refresh();
      return;
    }
    const failure = (await response.json().catch(() => ({}))) as Partial<PolicyRouteErrorBody>;
    switch (failure.error) {
      case "step_up_required":
        setNeedsStepUp(true);
        setError(
          "Confirm it’s you first: changing a policy needs a sign-in from the last 5 minutes.",
        );
        return;
      case "stale":
        setError(
          "Your policy changed since this page loaded. Reload the page to see it, then try again.",
        );
        return;
      default:
        setError(failure.message ?? "The policy wasn’t saved. Try again.");
    }
  }

  async function confirmWithPasskey() {
    setError(null);
    setPending("passkey");
    // Signed in, so Better Auth offers only this account's passkeys.
    const result = await authClient.signIn.passkey();
    setPending(null);
    if (result?.error) {
      setError(describeAuthError(result.error, "Passkey sign-in didn’t work. Try the email link."));
      return;
    }
    setNeedsStepUp(false);
    setMessage("Confirmed. You can save changes for the next 5 minutes.");
    router.refresh();
  }

  async function sendLink() {
    setError(null);
    setPending("email");
    const { error: failure } = await authClient.signIn.magicLink({
      email,
      callbackURL: HERE,
      errorCallbackURL: `/sign-in?reauth=1&next=${encodeURIComponent(HERE)}`,
    });
    setPending(null);
    if (failure) {
      setError(describeAuthError(failure, "We couldn’t send the link. Try again."));
      return;
    }
    setLinkSent(true);
  }

  return (
    <div className="grid gap-6">
      <p className="max-w-prose text-pretty text-sm" data-slot="policy-version">
        {policy ? (
          <>
            Version {policy.version}, changed by {changedBy ?? "you"}{" "}
            <When iso={policy.createdAt} now={Date.parse(loadedAt)} />.
          </>
        ) : (
          "No policy yet: every proposal waits for your review."
        )}
      </p>

      {steppedUp ? null : (
        <section
          aria-labelledby={headingId}
          className="grid gap-3 rounded-lg border border-state-conflict-border bg-state-conflict-bg px-4 py-3 text-sm text-state-conflict-text"
          data-slot="step-up"
        >
          <h3 id={headingId} className="font-medium">
            Confirm it’s you to change your policy
          </h3>
          <p className="text-pretty">
            A policy decides which proposals reach your CRM without you looking, so changing one
            needs a sign-in from the last 5 minutes.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {stepUp.hasPasskey ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pending !== null}
                onClick={confirmWithPasskey}
              >
                <KeyRoundIcon aria-hidden="true" />
                {pending === "passkey" ? "Waiting for your passkey…" : "Confirm with your passkey"}
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled={pending !== null} onClick={sendLink}>
                <MailIcon aria-hidden="true" />
                {pending === "email" ? "Sending…" : "Email me a sign-in link"}
              </Button>
            )}
            <Link href={reauthHref(HERE)} className={linkButton({ variant: "ghost", size: "sm" })}>
              Other ways to sign in
            </Link>
          </div>
          {linkSent ? (
            <p className="text-pretty">
              We sent a sign-in link to <span className="font-medium wrap-anywhere">{email}</span>.
              It brings you back here.
            </p>
          ) : null}
        </section>
      )}

      <fieldset className="grid gap-3" disabled={!steppedUp || pending === "save"}>
        <legend className="sr-only">Auto-approve, by proposal type</legend>
        {POLICY_TYPES.map((type) => {
          const copy = POLICY_TYPE_COPY[type];
          const choice = choices[type];
          const fields = ALWAYS_REVIEW_COPY[type];
          const labelId = `${idBase}-${type}-label`;
          const exampleId = `${idBase}-${type}-example`;
          return (
            <div
              key={type}
              className="grid gap-3 rounded-lg border px-4 py-3"
              data-policy-type={type}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="grid gap-1">
                  <p id={labelId} className="font-medium text-sm">
                    Auto-approve {copy.label.toLowerCase()}
                  </p>
                  <p id={exampleId} className="text-pretty text-muted-foreground text-sm">
                    For example, {copy.example}
                  </p>
                </div>
                <Switch
                  checked={choice.on}
                  onCheckedChange={(checked) => setType(type, checked)}
                  disabled={!steppedUp || pending === "save"}
                  aria-labelledby={labelId}
                  aria-describedby={exampleId}
                  className="mt-0.5"
                />
              </div>
              {choice.on && fields.length > 0 ? (
                <fieldset className="grid gap-2">
                  <legend className="mb-1 text-muted-foreground text-xs">
                    Always review {copy.label.toLowerCase()} with
                  </legend>
                  {fields.map(({ field, label, example }) => (
                    <label key={field} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={choice.alwaysReview.includes(field)}
                        onChange={(event) => setField(type, field, event.target.checked)}
                        className="mt-0.5 size-4 accent-foreground"
                      />
                      <span>
                        {label} <span className="text-muted-foreground">({example})</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : null}
            </div>
          );
        })}
      </fieldset>

      <p className="max-w-prose text-pretty text-muted-foreground text-sm">
        Even with auto-approve on, Earshot never approves a proposal it marked for a check, one
        whose record it isn’t sure of or that would create a record, or a correction. Each
        auto-approval shows in Reviewed with Undo, and a later conflict reopens it.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={!steppedUp || !dirty || pending !== null}>
          {pending === "save" ? "Saving…" : "Save policy"}
        </Button>
        {dirty && steppedUp ? (
          <p className="text-muted-foreground text-sm">Applies from your next debrief.</p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <p aria-live="polite" className="text-muted-foreground text-sm">
        {message}
      </p>
    </div>
  );
}
