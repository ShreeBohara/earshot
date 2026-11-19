// The cost meter (spec WP6 step 7): client usage priced from the dated table, LLM usage priced by
// the agent, totals in meta, and the total on session.ended.
import { scenario } from "@earshot/agent/testing";
import { describe, expect, it, vi } from "vitest";
import { PRICE_TABLE_DATE, priceStt } from "../../src/prices";
import { readMeter } from "../../src/session/meter";
import {
  canaryKey,
  endMessage,
  meta,
  open,
  startMessage,
  turnEndMessage,
  usageMessage,
  utteranceMessage,
} from "./helpers";

describe("speech-to-text prices", () => {
  it("bill AssemblyAI and Deepgram on socket time, keyterms included", () => {
    // 2.5 minutes of socket time at $0.19/hr (the spec's §6 estimate).
    expect(
      priceStt({
        provider: "assemblyai",
        model: "universal-streaming-english",
        audioMs: 120_000,
        socketMs: 150_000,
      }),
    ).toEqual({
      ok: true,
      costUsd: 0.007916667,
      priceTable: PRICE_TABLE_DATE,
    });
    expect(
      priceStt({ provider: "deepgram", model: "nova-3", audioMs: 60_000, socketMs: 120_000 }),
    ).toMatchObject({
      costUsd: 0.0122,
    });
    expect(
      priceStt({ provider: "fake", model: "fake", audioMs: 60_000, socketMs: 60_000 }),
    ).toMatchObject({ costUsd: 0 });
    expect(priceStt({ provider: "nobody", model: "x", audioMs: 1, socketMs: 1 })).toEqual({
      ok: false,
      reason: "unknown_model",
    });
  });
});

describe("the meter", () => {
  it("adds every usage record, and session.ended carries the total", async () => {
    const { socket, stub } = await open();
    await socket.request(startMessage());
    await socket.request(
      usageMessage("assemblyai", "universal-streaming-english", 120_000, 150_000),
    );
    const { turn } = scenario("anthropic", "demo-turn-4");
    for (const utterance of turn.utterances)
      await socket.request(utteranceMessage(turn.turnId, utterance));
    await socket.request(turnEndMessage(turn.turnId, canaryKey()));
    await socket.request(usageMessage("deepgram", "nova-3", 60_000, 120_000));

    // A provider the table doesn't know is recorded at $0, with the table's date, and logged.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await socket.request(usageMessage("fake-provider", "fake-model", 5_000, 5_000));
    expect(warn.mock.calls.flat().join(" ")).toContain(
      'usage unpriced {"kind":"stt","reason":"unknown_model"}',
    );
    warn.mockRestore();

    await socket.request(endMessage());
    const usages = socket
      .eventsOf("usage.recorded")
      .map((event) => event.payload as { kind: string; costUsd: number; priceTable: string });
    expect(usages.map((usage) => usage.kind)).toEqual(["stt", "llm", "stt", "stt"]);
    expect(usages.at(-1)).toMatchObject({ costUsd: 0, priceTable: PRICE_TABLE_DATE });
    const llm = usages[1];
    expect(llm?.costUsd).toBeGreaterThan(0);

    const total = Math.round(usages.reduce((sum, usage) => sum + usage.costUsd, 0) * 1e9) / 1e9;
    const ended = socket.eventsOf("session.ended")[0];
    expect(ended?.payload.costUsd).toBe(total);
    const meter = readMeter((await meta(stub)).meter);
    expect(meter).toMatchObject({
      costUsd: total,
      records: 4,
      stt: { audioMs: 185_000, socketMs: 275_000 },
      llm: { costUsd: llm?.costUsd },
    });
    expect(meter.stt.costUsd + meter.llm.costUsd).toBeCloseTo(total, 9);
    socket.close();
  });
});
