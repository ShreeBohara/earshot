// The recap's live check (Phase 5 spec §4.10 and WP10; ADR-0037): one recap on each provider, on
// keys from your environment, under $0.01 in all. It spends money, so it's off unless asked for
// twice over (the flag and the keys), and it refuses to start if its worst-case estimate is over
// the budget. Only a person runs it; CI never does.
//
//   EARSHOT_RECAP_LIVE=1 EVAL_ANTHROPIC_KEY=... EVAL_GROQ_KEY=... \
//     pnpm --filter @earshot/evals recap:live [--provider anthropic|groq|all] [--script d002]
//       [--budget 0.01] [--out recap-live.json] [--record <dir>]
//
// It prints numbers and fixed codes only, never a key, a prompt, or the recap's text. `--out`
// writes the same numbers as JSON. `--record <dir>` also keeps each provider's calls as a cassette
// for review, as packages/agent/scripts/record-cassettes.ts does: the recorder keeps no request
// headers (where the key travels) and refuses any interaction holding 8 characters of a key. The
// logic, and its $0 test, are in src/recap/live.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CASSETTE_VERSION,
  type CassetteFile,
  createRecordingFetch,
  type RecordingFetch,
} from "@earshot/agent/testing";
import type { LlmProvider } from "@earshot/core";
import {
  planRecapLive,
  RECAP_LIVE_MAX_USD,
  RECAP_LIVE_SCRIPT,
  recapLiveMarkdown,
  runRecapLive,
} from "../src/recap";
import { anyDebrief } from "../src/understanding";
import { flag, parseArgs, userPath } from "./args";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const chosen = flag(args, "provider") ?? "all";
  const providers: LlmProvider[] =
    chosen === "all"
      ? ["anthropic", "groq"]
      : chosen === "anthropic" || chosen === "groq"
        ? [chosen]
        : [];
  const script = anyDebrief(flag(args, "script") ?? RECAP_LIVE_SCRIPT);
  const plan = planRecapLive({
    providers,
    script,
    budgetUsd: Number(flag(args, "budget") ?? RECAP_LIVE_MAX_USD),
    env: process.env,
  });
  for (const estimate of plan.estimates) {
    console.log(
      `${estimate.provider}/${estimate.model}: estimated at most $${estimate.usd.toFixed(6)}`,
    );
  }
  if (!plan.ok) throw new Error(plan.refusal);

  const record = flag(args, "record");
  const recorders = new Map<LlmProvider, RecordingFetch>();
  const report = await runRecapLive(plan, {
    fetchFor: (provider) => {
      if (!record) return fetch;
      const recorder = createRecordingFetch(fetch, Object.values(plan.keys));
      recorders.set(provider, recorder);
      return recorder.fetch;
    },
    onResult: (result) => {
      const recorder = recorders.get(result.provider);
      if (!record || !recorder) return;
      const dir = userPath(record);
      mkdirSync(dir, { recursive: true });
      const file: CassetteFile = {
        version: CASSETTE_VERSION,
        provider: result.provider,
        model: result.model,
        source: "recorded",
        cassettes: {
          [script.id]: {
            name: script.id,
            description: `Recorded live: the recap of ${script.id}`,
            interactions: recorder.interactions(),
          },
        },
      };
      const out = path.join(
        dir,
        `recap-${result.provider}-${new Date().toISOString().slice(0, 10)}.json`,
      );
      writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
      console.log(`Recorded ${out}: review it before keeping it.`);
    },
  });
  console.log("");
  console.log(recapLiveMarkdown(report));
  const out = flag(args, "out");
  if (out) {
    writeFileSync(
      userPath(out),
      `${JSON.stringify({ checkedAt: new Date().toISOString(), ...report }, null, 2)}\n`,
    );
  }
  if (!report.passed) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
