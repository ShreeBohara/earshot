// Development only (see ../fake.ts): asks the edge Worker for its e2e scenario. Only
// `wrangler dev src/e2e.ts` answers it, so this doubles as the check that turns go to cassettes
// rather than to a real provider. app/(app)/capture/page.tsx imports it only under `next dev`.
import "server-only";
import { EntityRef } from "@earshot/core";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { readSessionConfig } from "../../voice/config";
import type { FakeScenario, FakeVoiceSetup } from "../fake";

/** apps/edge/src/e2e.ts's E2E_SCENARIO_PATH. */
const SCENARIO_PATH = "/v1/e2e/scenario";

function isScenario(value: unknown): value is FakeScenario {
  if (typeof value !== "object" || value === null) return false;
  const scenario = value as Partial<FakeScenario>;
  return (
    scenario.version === 1 &&
    typeof scenario.startedAt === "string" &&
    typeof scenario.timeZone === "string" &&
    EntityRef.array().safeParse(scenario.entities).success &&
    (scenario.llm?.provider === "anthropic" || scenario.llm?.provider === "groq") &&
    typeof scenario.llm.model === "string" &&
    Array.isArray(scenario.turns) &&
    scenario.turns.every((turn) => typeof turn?.text === "string" && turn.text.length > 0)
  );
}

export async function loadFakeVoiceSetup(): Promise<FakeVoiceSetup> {
  const { edgeOrigin } = readSessionConfig(getCloudflareContext().env, "development");
  const scenarioUrl = `${edgeOrigin.replace(/^ws/, "http")}${SCENARIO_PATH}`;
  try {
    const response = await fetch(scenarioUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    const body: unknown = response.ok ? await response.json() : null;
    return isScenario(body)
      ? { status: "ready", scenario: body }
      : { status: "unavailable", scenarioUrl };
  } catch {
    return { status: "unavailable", scenarioUrl };
  }
}
