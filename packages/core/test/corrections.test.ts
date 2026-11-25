// Phase 5 WP13's TypeScript-only contracts: the correction route's request, and the id of the
// proposal a correction makes, which both writers derive the same way.
import { describe, expect, it } from "vitest";
import {
  CorrectionRouteRequest,
  correctionProposalId,
  MAX_CORRECTION_TEXT_CHARS,
  MAX_DICTATED_UTTERANCES,
} from "../src";

const SESSION_ID = "01a1c6e2-9320-7deb-a57a-ba62dc02df02";
const OTHER_SESSION_ID = "01a1c6e2-9320-7deb-a57a-ba62dc02df03";
const PROPOSAL_ID = "01a1c6e2-b422-7d40-b863-98e9e102c114";
const CORRECTION_ID = "01a1c6e9-5c40-7e5f-8a6b-7c8d9e0f1a01";
const QUESTION_ID = "01a1c6e9-6d50-7f6a-9b7c-8d9e0f1a2b01";
const FAKE_GROQ_KEY = `gsk_${"Z".repeat(40)}`;

const typed = {
  t: "correct",
  correctionId: CORRECTION_ID,
  proposalId: PROPOSAL_ID,
  field: "target",
  said: { input: "typed", text: "No, it's Acme Robotics" },
};

const spoken = {
  ...typed,
  field: "dueDate",
  questionId: QUESTION_ID,
  said: {
    input: "speech",
    utterances: [
      {
        text: "Make it the 14th.",
        confidence: 0.92,
        startMs: 0,
        endMs: 1_380,
        words: [{ w: "Make", startMs: 120, endMs: 330, confidence: 0.95 }],
      },
    ],
  },
};

const accepts = (body: unknown) => CorrectionRouteRequest.safeParse(body).success;

describe("the correction route's request", () => {
  it("takes a typed or a spoken correction, and a skip", () => {
    expect(accepts(typed)).toBe(true);
    expect(accepts(spoken)).toBe(true);
    expect(accepts({ t: "skip", questionId: QUESTION_ID })).toBe(true);
  });

  it("caps typed text and dictated segments, and refuses an empty correction", () => {
    const text = (value: string) => ({ ...typed, said: { input: "typed", text: value } });
    expect(accepts(text("x".repeat(MAX_CORRECTION_TEXT_CHARS)))).toBe(true);
    expect(accepts(text("x".repeat(MAX_CORRECTION_TEXT_CHARS + 1)))).toBe(false);
    expect(accepts(text(""))).toBe(false);
    const segment = spoken.said.utterances[0];
    const many = (count: number) => ({
      ...spoken,
      said: { input: "speech", utterances: Array.from({ length: count }, () => segment) },
    });
    expect(accepts(many(MAX_DICTATED_UTTERANCES))).toBe(true);
    expect(accepts(many(MAX_DICTATED_UTTERANCES + 1))).toBe(false);
    expect(accepts(many(0))).toBe(false);
  });

  it("refuses missing and extra fields, a typed correction with words, and a skip with an answer", () => {
    const { correctionId: _, ...noId } = typed;
    expect(accepts(noId)).toBe(false);
    expect(accepts({ ...typed, by: "u_1" })).toBe(false);
    expect(accepts({ ...typed, said: { ...typed.said, words: [] } })).toBe(false);
    expect(accepts({ ...typed, said: { input: "pasted", text: "x" } })).toBe(false);
    expect(accepts({ t: "skip", questionId: QUESTION_ID, proposalId: PROPOSAL_ID })).toBe(false);
    expect(accepts({ ...typed, field: "Due date" })).toBe(false);
  });

  it("takes the rep's time zone, and nothing that isn't one", () => {
    expect(accepts({ ...typed, timeZone: "America/Chicago" })).toBe(true);
    expect(accepts({ ...typed, timeZone: "Mars/Olympus_Mons" })).toBe(false);
    expect(accepts({ ...typed, timeZone: "x".repeat(65) })).toBe(false);
  });

  it("refuses anything shaped like a key, in the words above all", () => {
    expect(accepts({ ...typed, said: { input: "typed", text: `it's ${FAKE_GROQ_KEY}` } })).toBe(
      false,
    );
    const segment = { ...spoken.said.utterances[0], text: FAKE_GROQ_KEY };
    expect(accepts({ ...spoken, said: { input: "speech", utterances: [segment] } })).toBe(false);
  });
});

describe("correctionProposalId", () => {
  it("derives one version-8 UUID per session and correction, whatever the case", async () => {
    const id = await correctionProposalId(SESSION_ID, CORRECTION_ID);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await correctionProposalId(SESSION_ID.toUpperCase(), CORRECTION_ID)).toBe(id);
    expect(await correctionProposalId(SESSION_ID, CORRECTION_ID.toUpperCase())).toBe(id);
  });

  it("differs in every other session, and for every other correction", async () => {
    const id = await correctionProposalId(SESSION_ID, CORRECTION_ID);
    expect(await correctionProposalId(OTHER_SESSION_ID, CORRECTION_ID)).not.toBe(id);
    expect(await correctionProposalId(SESSION_ID, QUESTION_ID)).not.toBe(id);
    // Never the correction's own id: the client can't choose a proposal id.
    expect(id).not.toBe(CORRECTION_ID);
  });
});
