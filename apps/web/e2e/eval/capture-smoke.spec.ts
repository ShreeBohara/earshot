// The fake-microphone smoke test (spec WP11 step 5), run before the eval (playwright.config.ts
// makes `capture-eval` depend on it): if Chrome's fake microphone plays silence, or its audio never
// reaches the fake speech-to-text adapter, nothing after it could mean anything, so the eval
// stops here with a message that says which.
import { turnTranscript } from "@earshot/evals";
import { expect, test } from "@playwright/test";
import { transcript } from "../capture/support";
import {
  evalScripts,
  fixture,
  launchWithWav,
  openFakeCapture,
  playTurns,
  readFakeStats,
  readProbe,
  signInWithDemoCrm,
  startDebrief,
} from "./support";

test.use({ trace: "retain-on-failure", video: "off", screenshot: "off" });

test("Chrome's fake microphone plays a debrief's WAV into the capture screen, and its PCM reaches the fake adapter", async ({
  playwright,
  baseURL,
}) => {
  test.skip(Boolean(process.env.BASE_URL), "Fake mode exists only under next dev.");
  test.setTimeout(150_000);
  const [first] = evalScripts();
  if (!first) throw new Error("EARSHOT_EVAL_SCRIPTS names no script");
  const fx = fixture(first.id);
  const { browser, page } = await launchWithWav(playwright, baseURL, fx);
  try {
    await signInWithDemoCrm(page);
    await openFakeCapture(page, fx, "anthropic");
    await startDebrief(page);
    const playback = await playTurns(page, fx.timing, 1);

    // The captured track carries sound: an AnalyserNode on it measured a non-zero RMS.
    const probe = await readProbe(page);
    const opened = probe?.opens[0];
    expect(opened, "the capture screen should have opened the microphone").toBeDefined();
    expect(
      probe?.peakRms ?? 0,
      `Chrome's fake microphone delivered silence from ${fx.wav}. Check the WAV (mono 16-bit PCM) ` +
        "and --use-file-for-fake-audio-capture; if it's the headless shell, try " +
        "EARSHOT_EVAL_CHANNEL=chromium (spec §8).",
    ).toBeGreaterThan(0.001);
    const firstTurn = fx.timing.turns[0];
    test.info().annotations.push(
      {
        type: "audio processing",
        description: JSON.stringify({
          echoCancellation: opened?.settings?.echoCancellation,
          noiseSuppression: opened?.settings?.noiseSuppression,
          autoGainControl: opened?.settings?.autoGainControl,
        }),
      },
      {
        type: "speech onset",
        description:
          probe?.onsetAt != null && firstTurn
            ? `${Math.round(probe.onsetAt - playback.micAt - firstTurn.startMs)} ms after timing.json's start, counting from getUserMedia`
            : "never heard",
      },
    );

    // The adapter got the press's PCM, and heard the whole line from it.
    await expect
      .poll(
        async () =>
          (await readFakeStats(page))?.adapters.reduce((sum, a) => sum + a.bytesReceived, 0) ?? 0,
        {
          message:
            "no PCM reached the fake speech-to-text adapter: the capture worklet or the engine's " +
            "push-to-talk gate never passed audio on",
          timeout: 10_000,
        },
      )
      .toBeGreaterThan(0);
    const line = fx.script.turns[0];
    if (!line) throw new Error(`${fx.script.id} has no turns`);
    await expect(
      transcript(page).locator("p").first(),
      "the fake adapter should have heard the first line in full",
    ).toHaveText(turnTranscript(line), { timeout: 20_000 });
  } finally {
    await browser.close();
  }
});
