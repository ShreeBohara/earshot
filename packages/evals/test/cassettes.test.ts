import { LLM_MODELS } from "@earshot/agent";
import { CASSETTE_VERSION, SCENARIO_API_KEY } from "@earshot/agent/testing";
import { containsKeyShape } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { DEBRIEFS, expectedDecision, expectedFields, turnTranscript } from "../src";
import { EVAL_CASSETTES, evalCassette } from "../src/cassettes";
import { EVAL_PROVIDERS, generateEvalCassettes, replayScript } from "../src/generate";

describe("the committed eval cassettes", () => {
  it("are what scripts/gen-cassettes.ts generates today (run `pnpm --filter @earshot/evals cassettes:gen` after changing a script, or after @earshot/agent changes its requests)", async () => {
    const generated = await generateEvalCassettes();
    expect(JSON.parse(JSON.stringify(generated))).toEqual(EVAL_CASSETTES);
  }, 60_000); // generating all 236 turns takes several seconds on CI runners

  it("hold one cassette per script and provider, with one interaction per turn", () => {
    for (const provider of EVAL_PROVIDERS) {
      const file = EVAL_CASSETTES[provider];
      expect(file).toMatchObject({
        version: CASSETTE_VERSION,
        provider,
        model: LLM_MODELS[provider],
        source: "hand-made",
      });
      expect(Object.keys(file.cassettes)).toEqual(DEBRIEFS.map((script) => script.id));
      for (const script of DEBRIEFS) {
        const cassette = evalCassette(provider, script.id);
        expect(cassette.interactions, `${provider} ${script.id}`).toHaveLength(script.turns.length);
        script.turns.forEach((turn, index) => {
          const excerpt = JSON.stringify(cassette.interactions[index]?.request.excerpt);
          // The request carries the turn's transcript verbatim (JSON-escaped).
          expect(excerpt).toContain(JSON.stringify(turnTranscript(turn)).slice(1, -1));
        });
      }
    }
    expect(() => evalCassette("groq", "d999")).toThrow(RangeError);
  });

  it("never hold a key or anything shaped like one", () => {
    for (const provider of EVAL_PROVIDERS) {
      const text = JSON.stringify(EVAL_CASSETTES[provider]);
      expect(text).not.toContain(SCENARIO_API_KEY);
      expect(containsKeyShape(text)).toBe(false);
    }
  });
});

describe.each(EVAL_PROVIDERS)("replaying the %s cassettes through the real adapter", (provider) => {
  it.each(DEBRIEFS.map((script) => [script.id, script] as const))(
    "%s yields exactly the expected proposals, turn by turn, with nothing left over",
    async (_id, script) => {
      const replay = await replayScript(provider, script, evalCassette(provider, script.id));
      expect(replay.misses).toBe(0);
      expect(replay.unplayed).toBe(0);
      script.turns.forEach((turn, index) => {
        const result = replay.results[index];
        const where = `${script.id} turn ${index + 1}`;
        expect(result?.outcome, where).toBe(
          turn.expect.length > 0 ? "proposals" : "nothing_to_propose",
        );
        expect(result?.completed.attempts, where).toBe(1);
        expect(result?.proposals, where).toHaveLength(turn.expect.length);
        turn.expect.forEach((expected, n) => {
          const actual = result?.proposals[n];
          const label = `${where} #${n + 1}`;
          expect(actual?.type, label).toBe(expected.type);
          // The linker's decision, from the words the cassette quotes (ADR-0027).
          const decision = expectedDecision(expected);
          expect(actual?.target.decision, label).toBe(decision);
          if (decision === "linked") {
            expect(actual?.target.entityId, label).toBe(expected.target.id);
          }
          if (decision === "ask") {
            expect(
              actual?.target.candidates.map((candidate) => candidate.entityId),
              label,
            ).toContain(expected.target.id);
          }
          expect(actual?.linker, label).toBe("linker.v1");
          const values = Object.fromEntries(
            Object.entries(actual?.fields ?? {}).map(([name, field]) => [name, field.value]),
          );
          const wanted = Object.fromEntries(
            expectedFields(expected).map(([name, field]) => [name, field.value]),
          );
          expect(values, `${where} #${n + 1}`).toEqual(wanted);
          // Every quote was found, so no field was dropped as unsupported.
          expect(
            actual?.riskFlags.map((flag) => flag.kind),
            `${where} #${n + 1}`,
          ).not.toContain("unsupported");
          // A new record is flagged as one, and nothing else is.
          expect(
            actual?.riskFlags.some((flag) => flag.kind === "new_entity"),
            label,
          ).toBe(decision === "new");
        });
      });
    },
  );
});
