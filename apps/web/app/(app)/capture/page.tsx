import type { Metadata } from "next";
import { CaptureScreen } from "@/components/capture/capture-screen";
import { requireViewer } from "@/lib/auth/viewer";
import {
  FAKE_LLM_PARAM,
  FAKE_SCRIPT_PARAM,
  FAKE_VOICE_PARAM,
  type FakeVoiceSetup,
} from "@/lib/capture/fake";

export const metadata: Metadata = { title: "Capture · Earshot" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * The capture screen. The session itself lives in (app)/layout.tsx's provider, so it survives
 * navigation; this page is its full-focus view.
 *
 * Development only: `?voice=fake` (or EARSHOT_FAKE_VOICE=1) runs the fake speech-to-text adapter
 * against the edge Worker's `dev:e2e` entry, so a debrief needs no keys and calls no provider
 * (CONTRIBUTING.md). `&script=d001` plays an eval debrief instead of the demo session, as the
 * fake-microphone eval does. Production builds compile the branch out.
 */
export default async function CapturePage({ searchParams }: { searchParams: SearchParams }) {
  await requireViewer("/capture");
  let fake: FakeVoiceSetup | null = null;
  if (process.env.NODE_ENV === "development") {
    const params = await searchParams;
    const asked = params[FAKE_VOICE_PARAM.name] === FAKE_VOICE_PARAM.value;
    if (asked || process.env.EARSHOT_FAKE_VOICE === "1") {
      const one = (value: string | string[] | undefined) =>
        typeof value === "string" ? value : undefined;
      const { loadFakeVoiceSetup } = await import("@/lib/capture/dev/scenario");
      fake = await loadFakeVoiceSetup({
        script: one(params[FAKE_SCRIPT_PARAM]),
        llm: one(params[FAKE_LLM_PARAM]),
      });
    }
  }
  return <CaptureScreen fake={fake} />;
}
