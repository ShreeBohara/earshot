// The controller with the browser's real dependencies. Safe to call while server rendering (a
// client component's state initializer runs there too): nothing touches the page until used.
import {
  createAssemblyAiAdapter,
  createAudioContext,
  createDebriefEngine,
  createDeepgramFluxAdapter,
  createDeepgramNova3Adapter,
  createGroqWitness,
  openMicrophone,
} from "@earshot/voice";
import { createSessionClient, isIosPlatform } from "@earshot/voice/session";
import { playChime, SpokenConfirmations } from "./audio-out";
import { CaptureController } from "./controller";
import { browserDeviceKeys } from "./keys";
import type { SttOption } from "./providers";
import { readWitnessSetting } from "./witness";

function adapterFor(option: SttOption) {
  switch (option.id) {
    case "assemblyai":
      return createAssemblyAiAdapter({ model: option.model });
    case "deepgram-nova3":
      return createDeepgramNova3Adapter();
    case "deepgram-flux":
      return createDeepgramFluxAdapter();
  }
}

export function createBrowserCaptureController(): CaptureController {
  const browser = typeof window !== "undefined";
  return new CaptureController({
    fetch: (input, init) => globalThis.fetch(input, init),
    keys: browserDeviceKeys(),
    openMicrophone: () => openMicrophone(),
    createAudioContext: () => {
      try {
        return createAudioContext();
      } catch {
        return undefined; // the engine reports audio_unavailable when it tries its own
      }
    },
    createEngine: createDebriefEngine,
    createClient: createSessionClient,
    createAdapter: adapterFor,
    clock: () => performance.now(),
    now: () => new Date(),
    timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    online: () => !browser || navigator.onLine,
    ios: browser && isIosPlatform(navigator),
    speech: new SpokenConfirmations(browser ? window.speechSynthesis : undefined),
    chime: playChime,
    // The second witness: the device's answer, read as each debrief starts, and Groq Whisper on
    // the device's Groq key, decrypted for each request (Phase 4 WP9).
    witnessSetting: () => (browser ? readWitnessSetting(window.localStorage) : null),
    createWitness: (key) => createGroqWitness({ key }),
  });
}

/** An iOS home-screen app, where WebKit stops the microphone on route changes (212040, 215884). */
export function isIosHomeScreenApp(): boolean {
  if (typeof window === "undefined" || !isIosPlatform(navigator)) return false;
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone || window.matchMedia?.("(display-mode: standalone)").matches === true;
}
