// The eval's live mode (EARSHOT_EVAL_MODE=live; spec WP11 step 8), run only by the eval-live
// workflow or by hand with keys in the environment. The same scripts and WAVs, on real providers:
// the keys go into Settings → Keys on this device, the capture screen runs on the pair picked,
// and the page's clock is pinned to the script's call time and time zone, since its expected
// dates ("by Friday") count from them. No traces, video, or screenshots, which could hold a key.
//
// AssemblyAI's free tier allows 5 new streams a minute: each session opens one, so the run waits
// before a session that would open a sixth. Runs are serial (--workers=1), so one counter will do.
import { type LivePair, parsePairs, streamDelayMs } from "@earshot/evals";
import { expect, type Page } from "@playwright/test";

export const LIVE = process.env.EARSHOT_EVAL_MODE === "live";

/** EVAL_LIVE_PAIRS, or the gate's four pairs. */
export function livePairs(): LivePair[] {
  return parsePairs(process.env.EVAL_LIVE_PAIRS);
}

const KEY_VARIABLES: Readonly<Record<string, string>> = {
  assemblyai: "EVAL_ASSEMBLYAI_KEY",
  deepgram: "EVAL_DEEPGRAM_KEY",
  anthropic: "EVAL_ANTHROPIC_KEY",
  groq: "EVAL_GROQ_KEY",
};

/** The capture screen's picker options (lib/capture/providers.ts), by provider and model. */
const STT_OPTIONS: Readonly<Record<string, string>> = {
  "assemblyai/universal-streaming-english": "assemblyai",
  "deepgram/nova-3": "deepgram-nova3",
  "deepgram/flux-general-en": "deepgram-flux",
};
const LLM_OPTIONS: Readonly<Record<string, string>> = {
  "anthropic/claude-haiku-5-5": "anthropic",
  "groq/openai/gpt-oss-20b": "groq",
};

const KEY_LABEL = "eval";

/** Saves the pair's two keys on this device, from the environment. */
export async function addKeys(page: Page, pair: LivePair): Promise<void> {
  await page.goto("/settings/keys");
  for (const provider of [pair.stt.provider, pair.llm.provider]) {
    const variable = KEY_VARIABLES[provider];
    const key = variable ? process.env[variable] : undefined;
    if (!variable || !key) throw new Error(`${variable ?? `a key for ${provider}`} isn't set`);
    await page.getByLabel("Provider", { exact: true }).selectOption(provider);
    await page.getByLabel("Label", { exact: true }).fill(KEY_LABEL);
    await page.getByLabel("Key", { exact: true }).fill(key);
    await page.getByRole("button", { name: "Check and save" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved on this device" })).toBeVisible({
      timeout: 30_000,
    });
  }
}

/** Opens the capture screen at the script's call time, on the pair's providers. */
export async function openLiveCapture(page: Page, pair: LivePair, callTime: string): Promise<void> {
  const stt = STT_OPTIONS[`${pair.stt.provider}/${pair.stt.model}`];
  const llm = LLM_OPTIONS[`${pair.llm.provider}/${pair.llm.model}`];
  if (!stt || !llm) throw new Error("the capture screen offers no such provider pair");
  await page.clock.setFixedTime(new Date(callTime));
  await page.goto("/capture");
  await expect(page.getByRole("heading", { level: 1, name: "Debrief" })).toBeVisible();
  await page.getByLabel("Speech-to-text").selectOption(`${stt}:${KEY_LABEL}`);
  await page.getByLabel("Model").selectOption(`${llm}:${KEY_LABEL}`);
  await expect(page.getByRole("button", { name: "Start debrief" })).toBeEnabled();
}

const streamsOpened: number[] = [];

/** Waits, if need be, so the session about to start opens at most the 5th stream this minute. */
export async function beforeStreamOpens(pair: LivePair): Promise<void> {
  if (pair.stt.provider !== "assemblyai") return;
  const wait = streamDelayMs(streamsOpened, Date.now());
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  streamsOpened.push(Date.now());
}
