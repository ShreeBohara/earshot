// The fake-microphone eval (spec WP11 step 4; gate G3): each debrief's WAV through Chrome's fake
// microphone into the real capture screen, one browser per WAV. Push-to-talk follows the WAV's
// timing.json, and every turn must end as its script says: `proposals` with each proposal's type,
// demo CRM target, and key fields exactly, or `nothing_to_propose`. Latency comes from each turn's
// `turn.measured`, which the eval reporter (reporter.ts) pools into p50 and p95.
//
// CI runs it on the fake speech-to-text adapter and the e2e edge Worker's cassettes (no keys, no
// provider calls): the smoke test and 5 scripts in `ui`, all 30 in `eval`. EARSHOT_EVAL_MODE=live
// runs it on real providers instead (live.ts). capture-smoke.spec.ts runs first; if it fails,
// this doesn't run.
import { pairName } from "@earshot/evals";
import { expect, test } from "@playwright/test";
import { addKeys, beforeStreamOpens, LIVE, livePairs, openLiveCapture } from "./live";
import {
  evalScripts,
  type Fixture,
  fixture,
  launchWithWav,
  openFakeCapture,
  type Playback,
  playTurns,
  RESULT_ATTACHMENT,
  readProbe,
  type SessionTap,
  scriptResult,
  signInWithDemoCrm,
  startDebrief,
  tapSession,
  waitForTurns,
} from "./support";

// Nothing recorded could hold a key in live mode. In CI, a failed run's trace is the debugger.
test.use({ trace: LIVE ? "off" : "retain-on-failure", video: "off", screenshot: "off" });

/** The LLM whose cassettes answer in CI: EARSHOT_EVAL_LLM=groq, or Anthropic's. */
const CI_LLM = process.env.EARSHOT_EVAL_LLM === "groq" ? "groq" : "anthropic";

const label = (provider: { provider: string; model: string } | undefined) =>
  provider ? `${provider.provider}/${provider.model}` : "unknown";

/** The providers the session started with, from its `session.started` event. */
function providersOf(tap: SessionTap) {
  const started = tap.events().find((event) => event.type === "session.started");
  const providers = (
    started?.payload as { providers?: Record<string, { provider: string; model: string }> }
  )?.providers;
  return { stt: label(providers?.speechToText), llm: label(providers?.llm) };
}

const runs = LIVE
  ? livePairs().flatMap((pair) =>
      evalScripts().map((script) => ({ script, pair, title: `${script.id} on ${pairName(pair)}` })),
    )
  : evalScripts().map((script) => ({ script, pair: null, title: `${script.id}: ${script.title}` }));

for (const { script, pair, title } of runs) {
  test(title, async ({ playwright, baseURL }, testInfo) => {
    const fx: Fixture = fixture(script.id);
    // Sign-in, the demo CRM, and a first compile under next dev, then the WAV in real time.
    test.setTimeout(fx.timing.durationMs + 180_000);
    const { browser, page } = await launchWithWav(playwright, baseURL, fx);
    const tap = tapSession(page);
    let playback: Playback | null = null;
    let failure: unknown = null;
    try {
      await signInWithDemoCrm(page);
      if (pair) {
        await addKeys(page, pair);
        await openLiveCapture(page, pair, script.callTime);
        await beforeStreamOpens(pair);
      } else {
        await openFakeCapture(page, fx, CI_LLM);
      }
      await startDebrief(page);
      playback = await playTurns(page, fx.timing);
      await waitForTurns(tap, script.turns.length, pair ? 60_000 : 30_000);
    } catch (error) {
      failure = error;
    }
    const providers = providersOf(tap);
    const result = scriptResult(fx, {
      mode: pair ? "live" : "ci",
      stt: pair ? label(pair.stt) : providers.stt,
      llm: pair ? label(pair.llm) : providers.llm,
      retry: testInfo.retry,
      playback,
      probe: await readProbe(page).catch(() => null),
      events: tap.events(),
      problems: failure
        ? [failure instanceof Error ? (failure.message.split("\n")[0] ?? "") : String(failure)]
        : [],
    });
    await testInfo.attach(RESULT_ATTACHMENT, {
      body: JSON.stringify(result),
      contentType: "application/json",
    });
    await browser.close();
    if (failure) throw failure;

    for (const turn of result.turns) {
      expect
        .soft(turn.problems, `turn ${turn.index + 1}: ${script.turns[turn.index]?.text}`)
        .toEqual([]);
    }
    expect(result.problems).toEqual([]);
  });
}
