import { cn } from "@earshot/ui/lib/utils";
import type { VoiceErrorCode } from "@earshot/voice";
import {
  CircleAlertIcon,
  InfoIcon,
  KeyRoundIcon,
  type LucideIcon,
  MicOffIcon,
  WifiOffIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { linkButton } from "@/components/link-button";
import type { StartProblem } from "@/lib/capture/controller";
import { VOICE_ERROR_COPY } from "@/lib/capture/copy";
import type { VoiceRouteError } from "@/lib/voice/types";
import { CaptureLink } from "./link";

type Tone = "info" | "warning" | "error";

const TONES: Record<Tone, string> = {
  info: "border-border bg-card text-card-foreground",
  warning: "border-state-conflict-border bg-state-conflict-bg text-state-conflict-text",
  error: "border-state-failed-border bg-state-failed-bg text-state-failed-text",
};

/**
 * A capture screen state that needs the rep: a missing key, a blocked microphone, a provider or
 * network failure. `alert` makes it a live alert, for problems that appear mid-session.
 */
export function CaptureNotice({
  tone,
  icon: Icon,
  title,
  children,
  action,
  alert = false,
  className,
}: {
  tone: Tone;
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  action?: ReactNode;
  alert?: boolean;
  className?: string;
}) {
  return (
    <div
      role={alert ? "alert" : undefined}
      data-slot="capture-notice"
      className={cn("flex gap-3 rounded-xl border p-4", TONES[tone], className)}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div className="flex min-w-0 flex-col gap-2">
        <p className="font-medium">{title}</p>
        <div className="text-pretty text-sm">{children}</div>
        {action ? <div className="flex flex-wrap gap-2 pt-1">{action}</div> : null}
      </div>
    </div>
  );
}

const KEYS_LINK = (
  <CaptureLink href="/settings/keys" className={linkButton({ variant: "outline", size: "sm" })}>
    Open Settings → Keys
  </CaptureLink>
);

/** No key on this device for speech-to-text, the LLM, or both. */
export function NoKeyNotice({ missing }: { missing: "stt" | "llm" | "both" }) {
  const what =
    missing === "both"
      ? "a speech-to-text key and a model key"
      : missing === "stt"
        ? "a speech-to-text key (AssemblyAI or Deepgram)"
        : "a model key (Groq or Anthropic)";
  return (
    <CaptureNotice
      tone="info"
      icon={KeyRoundIcon}
      title="Add your keys to start"
      action={KEYS_LINK}
    >
      A debrief runs on your own keys, kept on this device. This device needs {what}.
    </CaptureNotice>
  );
}

/** The microphone failed: blocked, stuck (WebKit 319706), missing, or audio wouldn't start. */
export function MicrophoneNotice({
  code,
  onRetry,
}: {
  code: Extract<
    VoiceErrorCode,
    "permission_denied" | "permission_stuck" | "device_unavailable" | "audio_unavailable"
  >;
  onRetry?: () => void;
}) {
  const copy = VOICE_ERROR_COPY[code];
  return (
    <CaptureNotice
      alert
      tone="error"
      icon={MicOffIcon}
      title={copy.title}
      action={
        onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className={linkButton({ variant: "outline", size: "sm" })}
          >
            Try again
          </button>
        ) : undefined
      }
    >
      {copy.body}
    </CaptureNotice>
  );
}

/** The speech provider refused or failed; the engine stays armed and the next press retries. */
export function ProviderNotice({ code, onRetry }: { code: VoiceErrorCode; onRetry?: () => void }) {
  const copy = VOICE_ERROR_COPY[code];
  return (
    <CaptureNotice
      alert
      tone={code === "provider_rejected" ? "error" : "warning"}
      icon={CircleAlertIcon}
      title={copy.title}
      action={
        code === "provider_rejected" ? (
          KEYS_LINK
        ) : onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className={linkButton({ variant: "outline", size: "sm" })}
          >
            Try again
          </button>
        ) : undefined
      }
    >
      {copy.body}
    </CaptureNotice>
  );
}

/** A passing problem that doesn't stop capture: keyterms refused, no VAD, a rate limit. */
export function VoiceNotice({ code }: { code: VoiceErrorCode }) {
  const copy = VOICE_ERROR_COPY[code];
  return (
    <CaptureNotice tone="warning" icon={InfoIcon} title={copy.title}>
      {copy.body}
    </CaptureNotice>
  );
}

export function OfflineNotice({ live }: { live: boolean }) {
  return (
    <CaptureNotice alert={live} tone="warning" icon={WifiOffIcon} title="You’re offline">
      {live
        ? "Earshot keeps the last minute of audio on this device and catches up when you’re back. Anything already sent is safe."
        : "A debrief needs a connection to start. Earshot starts as soon as you’re back online."}
    </CaptureNotice>
  );
}

const SESSION_COPY: Partial<Record<VoiceRouteError | "network", string>> = {
  network: "Earshot couldn’t be reached. Check your connection and try again.",
  unauthorized: "You’ve been signed out. Sign in again to start a debrief.",
  too_many_requests: "You’ve started a lot of debriefs in the last few minutes.",
  invalid_request: "Earshot couldn’t start a debrief with those providers.",
  server_error: "Earshot couldn’t start the debrief. Try again in a minute.",
};

/** Why a debrief didn't start. */
export function StartProblemNotice({ problem }: { problem: StartProblem }) {
  switch (problem.kind) {
    case "missing_key":
      return <NoKeyNotice missing="both" />;
    case "keys_unavailable":
      return (
        <CaptureNotice tone="warning" icon={KeyRoundIcon} title="This browser can’t open its keys">
          Its storage is turned off, as in some private windows. Open Earshot in a regular window,
          or add keys again in Settings → Keys.
        </CaptureNotice>
      );
    case "offline":
      return <OfflineNotice live={false} />;
    case "session": {
      const wait =
        problem.retryAfterSeconds === undefined
          ? ""
          : ` Try again in ${Math.max(1, Math.ceil(problem.retryAfterSeconds / 60))} min.`;
      return (
        <CaptureNotice alert tone="error" icon={CircleAlertIcon} title="The debrief didn’t start">
          {(SESSION_COPY[problem.error] ?? SESSION_COPY.server_error) + wait}
        </CaptureNotice>
      );
    }
  }
}

/** Fake mode was asked for, but the e2e edge Worker isn't the one listening. */
export function FakeEdgeNotice({ scenarioUrl }: { scenarioUrl: string }) {
  return (
    <CaptureNotice tone="warning" icon={InfoIcon} title="Fake mode needs the e2e edge Worker">
      The fake voice sends each turn to cassettes, which only the edge Worker&apos;s e2e entry
      serves, so nothing reaches a real provider. Nothing answered at{" "}
      <code className="break-all font-mono">{scenarioUrl}</code>. Stop any other edge Worker and run{" "}
      <code className="font-mono">pnpm --filter @earshot/edge dev:e2e</code>, then reload.
    </CaptureNotice>
  );
}
