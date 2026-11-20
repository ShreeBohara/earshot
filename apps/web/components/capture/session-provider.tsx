"use client";

import type { SessionState, SessionStore } from "@earshot/voice/session";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createBrowserCaptureController, isIosHomeScreenApp } from "@/lib/capture/browser";
import type { CaptureController, CaptureUiState } from "@/lib/capture/controller";
import { CaptureLinkContext } from "./link";
import { MiniSession } from "./mini-session";
import { useCaptureShortcuts } from "./use-capture-shortcuts";

const CaptureContext = createContext<CaptureController | null>(null);

export const CAPTURE_PATH = "/capture";

/**
 * Holds the one capture controller for the signed-in app. It lives in `(app)/layout.tsx`, which
 * client navigation doesn't remount, so a debrief survives moving between pages and the docked
 * mini-session can keep it going. Leaving the signed-in app ends capture.
 */
export function CaptureSessionProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(createBrowserCaptureController);
  const pathname = usePathname();
  const mounts = useRef(0);

  useEffect(() => {
    mounts.current += 1;
    controller.mount();
    const online = () => controller.setOnline(navigator.onLine);
    window.addEventListener("online", online);
    window.addEventListener("offline", online);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", online);
      // React's development double mount unmounts and remounts in one go: only a real unmount,
      // with no remount after it, ends capture.
      mounts.current -= 1;
      queueMicrotask(() => {
        if (mounts.current === 0) controller.dispose();
      });
    };
  }, [controller]);

  // An iOS home-screen app loses the microphone on route changes (WebKit 212040 and 215884), so
  // capture pauses there; the rep resumes with a tap.
  useEffect(() => {
    if (pathname && isIosHomeScreenApp()) controller.pauseCapture();
  }, [pathname, controller]);

  return (
    <CaptureContext value={controller}>
      <CaptureLinkContext value={Link}>{children}</CaptureLinkContext>
    </CaptureContext>
  );
}

export function useCaptureController(): CaptureController {
  const controller = use(CaptureContext);
  if (!controller)
    throw new Error("useCaptureController needs a <CaptureSessionProvider> above it");
  return controller;
}

export function useCaptureUi(): CaptureUiState {
  const controller = useCaptureController();
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

const noStore = () => () => {};
const noState = () => null;

/** The live session's state, or null before a session starts. */
export function useSessionState(store: SessionStore | null): SessionState | null {
  return useSyncExternalStore(
    store?.subscribe ?? noStore,
    store?.getState ?? noState,
    store?.getState ?? noState,
  );
}

/** What the rep is doing, in a word or two, for the docked bar and the screen's status. */
export function captureStatus(ui: CaptureUiState): string {
  if (ui.phase === "starting") return "Starting…";
  if (ui.phase === "ending") return "Ending…";
  if (ui.suspended) return "Paused";
  switch (ui.capture.state) {
    case "requesting_permission":
      return "Waiting for the microphone…";
    case "starting":
      return "Starting the microphone…";
    case "armed":
      return ui.mode === "hands_free" ? "Hands-free: waiting for speech" : "Ready: hold to talk";
    case "recording":
      return "Listening";
    case "finalizing":
      return "Sending…";
    case "reconnecting":
      return "Reconnecting to speech-to-text…";
    case "provider_unavailable":
      return "Speech-to-text unavailable";
    case "permission_denied":
    case "device_unavailable":
      return "Microphone unavailable";
    case "idle":
      return "Microphone off";
  }
}

/** The docked mini-session, everywhere in the signed-in app except the capture screen. */
export function DockedSession() {
  const controller = useCaptureController();
  const ui = useCaptureUi();
  const state = useSessionState(ui.store);
  const pathname = usePathname();
  const docked = (ui.phase === "live" || ui.phase === "ending") && pathname !== CAPTURE_PATH;
  const canTalk =
    ui.phase === "live" &&
    ["armed", "recording", "finalizing", "reconnecting", "provider_unavailable"].includes(
      ui.capture.state,
    );

  useCaptureShortcuts(controller, "dock", { enabled: docked && canTalk });

  if (!docked) return null;
  const utterances = state?.projections.utterances ?? [];
  return (
    <>
      {/* Keeps the page's end clear of the fixed bar. */}
      <div aria-hidden="true" className="h-16" />
      <MiniSession
        levels={controller.levels}
        status={captureStatus(ui)}
        lastLine={ui.partial ?? utterances.at(-1)?.text ?? null}
        proposalCount={state?.projections.proposals.length ?? 0}
        mode={ui.mode}
        pressed={ui.pressed}
        canTalk={canTalk}
        suspended={ui.suspended}
        onPress={() => controller.press()}
        onRelease={(at) => controller.release(at)}
        onResume={() => controller.resumeCapture()}
        onEnd={() => void controller.end()}
        href={CAPTURE_PATH}
      />
    </>
  );
}
