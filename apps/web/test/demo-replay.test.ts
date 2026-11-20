import { readFileSync } from "node:fs";
import { defaultProjections, fromJsonl, replay } from "@earshot/events";
import { describe, expect, it } from "vitest";
import {
  buildReplayTimeline,
  DEMO_ENTITIES,
  micLevelAt,
  ReplayDriver,
  type ReplaySpeed,
  replayActivity,
} from "@/lib/demo-replay";
import { findInRepo } from "@/lib/repo-path";
import { ManualClock } from "./support/manual-clock";

const log = fromJsonl(
  readFileSync(findInRepo("packages/events/fixtures/demo-session.jsonl"), "utf8"),
);

/** Each event's offset from session.started (19:15:00.040), by its `ts`. */
const OFFSETS = [
  0, 7_240, 8_410, 13_110, 19_920, 21_140, 25_200, 26_470, 32_230, 33_580, 38_410, 39_680, 40_090,
  40_220, 46_860, 49_760, 61_560, 64_860, 69_660,
];

/** The first utterance's words, as its partial ends up (no punctuation, as partials come). */
const FIRST_WORDS =
  "Just got out of the meeting with Acme Corp Met Dana Lee their new VP of Operations";
const FIRST_LINE =
  "Just got out of the meeting with Acme Corp. Met Dana Lee, their new VP of Operations.";

function start(speed: ReplaySpeed = 1) {
  const clock = new ManualClock();
  const driver = new ReplayDriver(buildReplayTimeline(log), { clock, speed });
  const state = () => driver.getView().store.getState();
  const lines = () => state().projections.utterances.map((u) => u.text);
  return { clock, driver, state, lines };
}

/** When each event folded, by the clock, with the seq it brought the store to. */
function recordFolds(driver: ReplayDriver, clock: ManualClock) {
  const folds: { seq: number; at: number }[] = [];
  const { store } = driver.getView();
  store.subscribe(() => folds.push({ seq: store.getState().lastSeq, at: clock.now() }));
  return folds;
}

function expectNear(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => {
    expect(Math.abs(value - (expected[index] ?? Number.NaN)), `#${index}`).toBeLessThan(0.02);
  });
}

describe("the replay timeline", () => {
  it("puts each event at its offset from session.started, by ts", () => {
    const timeline = buildReplayTimeline(log);
    const events = timeline.cues.filter((cue) => cue.kind === "event");
    expect(events.map((cue) => cue.event.seq)).toEqual(OFFSETS.map((_, seq) => seq));
    expect(events.map((cue) => cue.at)).toEqual(OFFSETS);
    expect(timeline.durationMs).toBe(69_660);
  });

  it("reveals timed utterances word by word, ahead of their final, and the others not at all", () => {
    const timeline = buildReplayTimeline(log);
    const words = timeline.cues.filter((cue) => cue.kind === "words");
    // Two utterances carry word timings: 17 words, then 10.
    expect(words).toHaveLength(27);
    // "Just" ends at 1,470 ms of audio; audio starts 40 ms before the session.started event.
    expect(words[0]).toMatchObject({ at: 1_430, text: "Just" });
    expect(words[16]).toMatchObject({ at: 6_790, text: FIRST_WORDS });
    expect(words[17]).toMatchObject({ at: 20_350, text: "I" });
    const final = timeline.cues.findIndex((cue) => cue.kind === "event" && cue.event.seq === 1);
    expect(timeline.cues.slice(final - 17, final).every((cue) => cue.kind === "words")).toBe(true);
  });

  it("needs a log that opens with session.started", () => {
    expect(() => buildReplayTimeline(log.slice(1))).toThrow(/session\.started/);
  });

  it("synthesizes the mic level from word timings", () => {
    const timeline = buildReplayTimeline(log);
    expect(micLevelAt(timeline, 500)).toBe(0); // before anyone speaks
    expect(micLevelAt(timeline, 2_735)).toBeGreaterThan(0.6); // mid "meeting"
    expect(micLevelAt(timeline, 1_465)).toBe(0.06); // between "Just" and "got"
    expect(micLevelAt(timeline, 7_000)).toBe(0); // after the last word, before the next line
    // Utterances without timings still move the orb, from words spread over their audio.
    expect(micLevelAt(timeline, 10_000)).toBeGreaterThan(0);
  });
});

describe("ReplayDriver", () => {
  it("folds every event in order, each at its offset", async () => {
    const { clock, driver } = start();
    const folds = recordFolds(driver, clock);
    driver.play();
    await clock.advance(70_000);
    expect(folds.map((fold) => fold.seq)).toEqual(OFFSETS.map((_, seq) => seq));
    expectNear(
      folds.map((fold) => fold.at),
      OFFSETS,
    );
    expect(driver.getView()).toMatchObject({ status: "ended", applied: 19, positionMs: 69_660 });
  });

  it("folds into the same state a straight replay builds", async () => {
    const { clock, driver, state } = start();
    driver.play();
    await clock.advance(70_000);
    expect(state().projections).toEqual(replay(log, defaultProjections));
    expect(state().fold).toBe("live");
  });

  it.each([2, 8] as const)("divides every wait at %i×", async (speed) => {
    const { clock, driver } = start(speed);
    const folds = recordFolds(driver, clock);
    driver.play();
    await clock.advance(70_000 / speed);
    expectNear(
      folds.map((fold) => fold.at),
      OFFSETS.map((offset) => offset / speed),
    );
  });

  it("ends 8× playback in under 9 seconds", async () => {
    const { clock, driver } = start(8);
    driver.play();
    await clock.advance(8_707);
    expect(driver.getView().status).toBe("playing");
    await clock.advance(1);
    expect(driver.getView().status).toBe("ended");
    expect(clock.pending).toBe(0);
  });

  it("keeps the position when the speed changes mid-play", async () => {
    const { clock, driver, lines } = start();
    driver.play();
    await clock.advance(4_000);
    driver.setSpeed(2);
    expect(driver.getView().speed).toBe(2);
    // 3,240 ms of session time to the first final, at 2×.
    await clock.advance(1_619);
    expect(lines()).toEqual([]);
    await clock.advance(1);
    expect(lines()).toEqual([FIRST_LINE]);
  });

  it("runs one timer at a time through speed changes, and none once paused", async () => {
    const { clock, driver } = start();
    driver.play();
    await clock.advance(500);
    driver.setSpeed(2);
    driver.setSpeed(1);
    driver.setSpeed(2);
    expect(clock.pending).toBe(1);
    driver.pause();
    expect(clock.pending).toBe(0);
    const paused = driver.getView();
    await clock.advance(70_000);
    expect(driver.getView()).toBe(paused);
    expect(driver.levels.get().mic).toBe(0);
  });

  it("holds still while paused and carries on from there", async () => {
    const { clock, driver, lines } = start();
    driver.play();
    await clock.advance(7_000);
    driver.pause();
    expect(driver.getView()).toMatchObject({ status: "paused", positionMs: 7_000, applied: 1 });
    expect(driver.levels.get().mic).toBe(0);
    expect(clock.pending).toBe(0);
    await clock.advance(60_000);
    expect(lines()).toEqual([]);
    expect(driver.position()).toBe(7_000);

    driver.toggle();
    expect(driver.getView().status).toBe("playing");
    await clock.advance(239);
    expect(lines()).toEqual([]);
    await clock.advance(1);
    expect(lines()).toEqual([FIRST_LINE]);
  });

  it("shows timed words one by one as the partial, then the final whole", async () => {
    const { clock, driver, lines } = start();
    const partial = () => driver.getView().partial;
    driver.play();
    await clock.advance(1_429);
    expect(partial()).toBeNull();
    await clock.advance(1);
    expect(partial()).toBe("Just");
    await clock.advance(270); // "got" ends at 1,700
    expect(partial()).toBe("Just got");
    await clock.advance(6_790 - 1_700);
    expect(partial()).toBe(FIRST_WORDS);
    await clock.advance(7_239 - 6_790);
    expect(partial()).toBe(FIRST_WORDS);
    expect(lines()).toEqual([]);
    await clock.advance(1);
    expect(partial()).toBeNull();
    expect(lines()).toEqual([FIRST_LINE]);

    // The next utterance has no timings: no partial, then the whole line at its offset.
    await clock.advance(13_109 - 7_240);
    expect(partial()).toBeNull();
    expect(lines()).toHaveLength(1);
    await clock.advance(1);
    expect(partial()).toBeNull();
    expect(lines()).toHaveLength(2);
  });

  it("moves the orb only while someone speaks", async () => {
    const { clock, driver } = start();
    const mic = () => driver.levels.get().mic;
    driver.play();
    await clock.advance(500);
    expect(mic()).toBe(0);
    await clock.advance(800); // inside "Just"
    expect(mic()).toBeGreaterThan(0.3);
    await clock.advance(7_000 - 1_300); // the first line is over
    expect(mic()).toBe(0);
    await clock.advance(1_000); // the second line, estimated from its text
    expect(mic()).toBeGreaterThan(0);
    driver.pause();
    expect(mic()).toBe(0);
  });

  it("skips to the end: everything folded, the reviews in, nothing left to run", async () => {
    const { clock, driver, state } = start();
    driver.play();
    await clock.advance(2_000);
    driver.skipToEnd();
    expect(driver.getView()).toMatchObject({
      status: "ended",
      applied: 19,
      partial: null,
      positionMs: 69_660,
    });
    expect(state().lastSeq).toBe(18);
    expect(state().projections.proposals.map((p) => p.status)).toEqual([
      "approved",
      "approved",
      "edited",
      "approved",
      "rejected",
    ]);
    expect(driver.levels.get().mic).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it("restarts from the top with a new store, and plays again after the end", async () => {
    const { clock, driver, state, lines } = start();
    driver.play();
    await clock.advance(30_000);
    const first = driver.getView().store;
    expect(first.getState().lastSeq).toBe(7);

    driver.restart();
    expect(driver.getView().store).not.toBe(first);
    expect(driver.getView()).toMatchObject({ status: "playing", applied: 1, partial: null });
    expect(state().lastSeq).toBe(0);
    await clock.advance(7_240);
    expect(lines()).toEqual([FIRST_LINE]);
    expect(first.getState().lastSeq).toBe(7); // the old run's store is left alone

    driver.skipToEnd();
    const ended = driver.getView().store;
    driver.play();
    expect(driver.getView().store).not.toBe(ended);
    expect(driver.getView()).toMatchObject({ status: "playing", applied: 1 });
  });

  it("changes speed while stopped without starting", () => {
    const { clock, driver } = start();
    driver.setSpeed(8);
    expect(driver.getView()).toMatchObject({ status: "ready", speed: 8, applied: 0 });
    expect(clock.pending).toBe(0);
  });

  it("stops its timer on dispose", async () => {
    const { clock, driver, lines } = start();
    driver.play();
    await clock.advance(1_000);
    driver.dispose();
    expect(clock.pending).toBe(0);
    await clock.advance(70_000);
    expect(lines()).toEqual([]);
    expect(driver.getView().status).toBe("paused");
  });

  it("emits a new view only when something visible changes", async () => {
    const { clock, driver } = start();
    let views = 0;
    driver.subscribe(() => views++);
    driver.play();
    await clock.advance(1_000);
    // The start (session.started), then the clock's first whole second. The orb's ticks between
    // don't count: they go to the level meter.
    expect(views).toBe(2);
  });
});

describe("the replay's feed rows and records", () => {
  it("adds each proposal as it arrives and each review decision", async () => {
    const { clock, driver, state } = start(8);
    driver.play();
    await clock.advance(9_000);
    expect(replayActivity(state()).map((row) => [row.kind, row.text])).toEqual([
      ["response", "Proposed a contact."],
      ["response", "Proposed a deal update."],
      ["response", "Proposed a task."],
      ["response", "Proposed a note."],
      ["response", "Proposed a commitment."],
      ["action", "Review: approved the contact."],
      ["action", "Review: approved the deal update."],
      ["action", "Review: edited the task, then approved it."],
      ["action", "Review: approved the note."],
      ["action", "Review: rejected the commitment."],
    ]);
    // Rows sit at their event's session time.
    expect(replayActivity(state())[0]?.at).toBe(8_410);
  });

  it("names every record the log's proposals target", () => {
    const ids = new Set(DEMO_ENTITIES.map((entity) => entity.id));
    const targets = replay(log, defaultProjections).proposals.flatMap((p) =>
      p.targetEntityId === null ? [] : [p.targetEntityId],
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(ids.has(target), target).toBe(true);
  });
});
