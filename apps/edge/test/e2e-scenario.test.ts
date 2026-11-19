// The e2e entry's scenario route (src/e2e-scenario.ts), which the capture screen's fake mode
// reads: it must describe exactly the session the cassettes were recorded for, the demo
// session's or an eval script's. And the e2e entry must answer each turn from that cassette.
import type { ExtractorOptions, ProposalExtractor, RunTurnInput, TurnResult } from "@earshot/agent";
import {
  DEMO_CALL_TIME,
  DEMO_ENTITIES,
  DEMO_TIME_ZONE,
  DEMO_UTTERANCES,
} from "@earshot/agent/testing";
import { DEBRIEFS, debrief, sessionContext, turnTranscript } from "@earshot/evals";
import { evalCassette } from "@earshot/evals/cassettes";
import { describe, expect, it } from "vitest";
import { type TurnAgent, withTurnFetch } from "../src/agent";
import { demoCassette, turnCassette } from "../src/e2e";
import {
  E2E_SCENARIO_PATH,
  e2eScenario,
  evalScenario,
  handleE2eRequest,
} from "../src/e2e-scenario";

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

describe("the eval scenarios", () => {
  it.each(DEBRIEFS.map((script) => [script.id]))(
    "%s runs in its cassettes' session context, one press per turn",
    (id) => {
      const script = debrief(id);
      const scenario = evalScenario(id);
      const context = sessionContext(script);
      expect(scenario).toMatchObject({
        version: 1,
        name: id,
        startedAt: context.callTime,
        timeZone: context.timeZone,
        llm: { provider: "anthropic", model: "claude-haiku-5-5" },
      });
      expect(scenario?.entities).toBe(context.entities);
      expect(scenario?.turns.map((turn) => turn.text)).toEqual(script.turns.map(turnTranscript));
      // The e2e Worker finds the script's cassette by the call time `start` carries.
      for (const provider of ["anthropic", "groq"] as const) {
        expect(turnCassette(provider, scenario?.startedAt ?? "")).toBe(evalCassette(provider, id));
      }
    },
  );

  it("are served by script id, for either LLM, and refuse what they don't know", async () => {
    const url = (query: string) => `http://edge.test${E2E_SCENARIO_PATH}?${query}`;
    const d001 = handleE2eRequest(new Request(url("script=d001")));
    expect(d001?.status).toBe(200);
    expect(d001?.headers.get("cache-control")).toBe("no-store");
    expect(await d001?.json()).toEqual(JSON.parse(JSON.stringify(evalScenario("d001"))));
    const groq = await handleE2eRequest(new Request(url("script=d002&llm=groq")))?.json();
    expect(groq).toMatchObject({
      name: "d002",
      llm: { provider: "groq", model: "openai/gpt-oss-20b" },
    });
    const demoOnGroq = await handleE2eRequest(new Request(url("llm=groq")))?.json();
    expect(demoOnGroq).toMatchObject({ name: "demo-session", llm: { provider: "groq" } });
    expect(handleE2eRequest(new Request(url("script=d999")))?.status).toBe(404);
    expect(handleE2eRequest(new Request(url("script=d001&llm=openai")))?.status).toBe(400);
  });

  it("leave the demo session's cassette for any other call time", () => {
    expect(turnCassette("anthropic", DEMO_CALL_TIME)).toEqual(demoCassette("anthropic"));
    expect(turnCassette("groq", "2030-01-01T00:00:00.000Z")).toEqual(demoCassette("groq"));
  });
});

describe("withTurnFetch", () => {
  it("rebuilds each turn's extractor with the fetch its session context picks", async () => {
    const built: ExtractorOptions[] = [];
    const ran: RunTurnInput[] = [];
    const agent = {
      createProposalExtractor: (options: ExtractorOptions) => {
        built.push(options);
        return { provider: options.provider, model: options.model } as ProposalExtractor;
      },
      runTurn: async (input: RunTurnInput) => {
        ran.push(input);
        return {} as TurnResult;
      },
      aiGatewayFromEnv: () => undefined,
    } as unknown as TurnAgent;
    const fetches = new Map<string, typeof fetch>();
    const wrapped = withTurnFetch(agent, (provider, turn) => {
      const chosen = (() => Promise.reject(new Error("unused"))) as unknown as typeof fetch;
      fetches.set(`${provider} ${turn.callTime} ${turn.timeZone}`, chosen);
      return chosen;
    });
    const extractor = wrapped.createProposalExtractor({
      provider: "groq",
      model: "openai/gpt-oss-20b",
    });
    await wrapped.runTurn({
      extractor,
      turnId: "t1",
      utterances: [],
      entities: [],
      callTime: "2026-11-17T22:20:00.000Z",
      timeZone: "America/Los_Angeles",
      apiKey: "k",
    } as unknown as RunTurnInput);
    const chosen = fetches.get("groq 2026-11-17T22:20:00.000Z America/Los_Angeles");
    expect(chosen).toBeDefined();
    expect(built).toHaveLength(2);
    expect(built[1]).toMatchObject({
      provider: "groq",
      model: "openai/gpt-oss-20b",
      fetch: chosen,
    });
    expect(ran[0]?.extractor).not.toBe(extractor);
    expect(ran[0]?.extractor).toMatchObject({ provider: "groq" });
  });
});
