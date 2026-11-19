// The e2e entry's scenario route (src/e2e-scenario.ts), which the capture screen's fake mode
// reads: it must describe exactly the session the demo cassettes were recorded for.
import {
  DEMO_CALL_TIME,
  DEMO_ENTITIES,
  DEMO_TIME_ZONE,
  DEMO_UTTERANCES,
} from "@earshot/agent/testing";
import { describe, expect, it } from "vitest";
import { demoCassette } from "../src/e2e";
import { E2E_SCENARIO_PATH, e2eScenario, handleE2eRequest } from "../src/e2e-scenario";

describe("the e2e scenario", () => {
  it("is the demo session: its entities, call time, zone, and lines, for the recorded LLM", () => {
    const scenario = e2eScenario();
    expect(scenario).toMatchObject({
      version: 1,
      startedAt: DEMO_CALL_TIME,
      timeZone: DEMO_TIME_ZONE,
      entities: DEMO_ENTITIES,
      llm: { provider: "anthropic", model: "claude-haiku-5-5" },
    });
    expect(scenario.turns.map((turn) => turn.text)).toEqual(DEMO_UTTERANCES.map((u) => u.text));
    // One recorded answer per line, so every press gets one.
    expect(demoCassette(scenario.llm.provider).interactions).toHaveLength(scenario.turns.length);
  });

  it("answers GET on its path only, uncached, and leaves everything else to the Worker", async () => {
    const response = handleE2eRequest(new Request(`http://edge.test${E2E_SCENARIO_PATH}`));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.json()).toEqual(JSON.parse(JSON.stringify(e2eScenario())));
    const post = handleE2eRequest(
      new Request(`http://edge.test${E2E_SCENARIO_PATH}`, { method: "POST" }),
    );
    expect(post?.status).toBe(405);
    expect(handleE2eRequest(new Request("http://edge.test/v1/sessions/x/ws"))).toBeUndefined();
    expect(handleE2eRequest(new Request("http://edge.test/health"))).toBeUndefined();
  });
});
