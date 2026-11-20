// The recap in workerd (Phase 5 WP10): the forced `submit_recap` call through both AI SDK 7
// adapters, the checks (with `@earshot/understanding`'s content-word overlap), and the lens files
// as JSON imports, inside workerd with the edge Worker's compatibility date and flags, where
// SessionDO runs it. The scripted model answers; nothing reaches a provider.
import { RecapCreatedV1, UsageRecordedV1 } from "@earshot/core";
import { describe, expect, it } from "vitest";
import { createRecapper, RECAP_LENSES, runRecap } from "../../src/recap";
import { DEMO_UTTERANCES, SCENARIO_API_KEY, scriptedRecapFetch } from "../../src/testing";

describe("the recap in workerd", () => {
  it("reads the lens files", () => {
    expect(RECAP_LENSES.meddic.fields).toHaveLength(6);
  });

  for (const provider of ["anthropic", "groq"] as const) {
    it(`${provider}: writes the demo session's recap, checked and priced`, async () => {
      const result = await runRecap({
        recapper: createRecapper({
          provider,
          fetch: scriptedRecapFetch({ provider }) as typeof fetch,
        }),
        utterances: DEMO_UTTERANCES,
        proposals: [],
        lens: "spiced",
        apiKey: SCENARIO_API_KEY,
        signal: new AbortController().signal,
      });
      RecapCreatedV1.parse(result.recap);
      UsageRecordedV1.parse(result.usage);
      expect(result.recap).toMatchObject({
        outcome: "created",
        dropped: 0,
        lens: { id: "spiced" },
      });
      expect(result.recap.sentences[0]?.kind).toBe("headline");
    });
  }
});
