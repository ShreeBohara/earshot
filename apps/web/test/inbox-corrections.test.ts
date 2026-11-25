// The inbox's side of corrections and follow-up questions (Phase 5 spec WP13; ADR-0038): where a
// correction's card goes, what a failed correction says, and where each sink sends its words.
import type { CorrectionDelivery } from "@earshot/voice/session";
import { describe, expect, it } from "vitest";
import {
  type CorrectionWriter,
  correctionFailureLine,
  failureOf,
  routeCorrectionSink,
  socketCorrectionSink,
} from "@/lib/inbox/corrections";
import { followupStopId } from "@/lib/inbox/focus";
import { cardOrder, inboxSections } from "@/lib/inbox/groups";
import type { InboxProposal, InboxSession } from "@/lib/inbox/types";

const SESSION_ID = "01a1c6e2-0000-7000-8000-0000000000aa";
const NOW = Date.parse("2026-11-20T16:00:00.000Z");

let next = 0;
function proposal(overrides: Partial<InboxProposal> = {}): InboxProposal {
  next += 1;
  return {
    proposalId: `01a1c6e2-0000-7000-8000-${next.toString().padStart(12, "0")}`,
    type: "task",
    targetEntityId: null,
    target: {
      decision: "none",
      entityId: null,
      kind: null,
      basis: null,
      p: 0,
      mention: null,
      company: null,
      candidates: [],
    },
    status: "proposed",
    fields: {},
    riskFlags: [],
    conflicts: [],
    supersedes: null,
    supersededBy: null,
    snoozedUntil: null,
    followups: [],
    seq: next,
    ts: "2026-11-20T15:00:00.000Z",
    review: null,
    ...overrides,
  };
}

function session(proposals: readonly InboxProposal[]): InboxSession {
  return {
    sessionId: SESSION_ID,
    startedAt: "2026-11-20T15:00:00.000Z",
    endedAt: "2026-11-20T15:02:00.000Z",
    sealedAt: "2026-11-20T15:03:00.000Z",
    focusEntityId: null,
    proposals,
  };
}

describe("a correction's card", () => {
  it("takes the place of the card it replaced, down a chain of corrections", () => {
    const first = proposal();
    const second = proposal();
    const third = proposal();
    const corrected = proposal({ supersedes: second.proposalId });
    const again = proposal({ supersedes: corrected.proposalId });
    const sections = inboxSections(
      [
        session([
          first,
          { ...second, status: "superseded", supersededBy: corrected.proposalId },
          third,
          { ...corrected, status: "superseded", supersededBy: again.proposalId },
          again,
        ]),
      ],
      {},
      NOW,
    );
    expect(cardOrder(sections.review)).toEqual([
      [first.proposalId, again.proposalId, third.proposalId],
    ]);
    expect(sections.openCount).toBe(3);
  });

  it("keeps the order the proposals were made in when nothing was corrected", () => {
    const cards = [proposal(), proposal(), proposal()];
    const sections = inboxSections([session(cards)], {}, NOW);
    expect(cardOrder(sections.review)).toEqual([cards.map((card) => card.proposalId)]);
  });

  it("names a follow-up question's focus stop apart from any card", () => {
    expect(followupStopId("01a1c6e2-0000-7000-8000-00000000f001")).toBe(
      "followup:01a1c6e2-0000-7000-8000-00000000f001",
    );
  });
});

describe("what a failed correction says", () => {
  it("quotes the rep's own words back for a value it couldn't read, cut at 60 characters", () => {
    expect(
      correctionFailureLine("unreadable", { type: "task", field: "dueDate", words: "whenever" }),
    ).toBe("I couldn't read a date in “whenever”.");
    expect(
      correctionFailureLine("unreadable", {
        type: "deal_update",
        field: "amount",
        words: "a".repeat(70),
      }),
    ).toBe(`I couldn't read an amount in “${"a".repeat(60)}…”.`);
    expect(
      correctionFailureLine("unreadable", { type: "contact", field: "target", words: "um" }),
    ).toBe("I couldn't read a record in “um”.");
  });

  it("says “what you said” for a spoken correction, whose words the page never kept", () => {
    expect(
      correctionFailureLine("unreadable", { type: "meeting", field: "time", words: null }),
    ).toBe("I couldn't read a time in what you said.");
  });

  it("says why the rest failed, and what to do instead", () => {
    const context = { type: "task", field: "title", words: "Send it" } as const;
    expect(correctionFailureLine("too_many", context)).toMatch(/Edit or reject it instead\.$/);
    expect(correctionFailureLine("stale", context)).toMatch(/Reload it and try again\.$/);
    expect(correctionFailureLine("not_sealed", context)).toMatch(/still finishing/);
    expect(correctionFailureLine("unavailable", context)).toMatch(/Try again in a minute\.$/);
  });

  it("maps SessionDO's limits to “too many”, and transport failures to “unavailable”", () => {
    expect(failureOf("turn_limit")).toBe("too_many");
    expect(failureOf("duration_limit")).toBe("too_many");
    expect(failureOf("too_many")).toBe("too_many");
    expect(failureOf("unreadable")).toBe("unreadable");
    expect(failureOf("sealed")).toBe("unavailable");
    expect(failureOf("closed")).toBe("unavailable");
    expect(failureOf("server_error")).toBe("unavailable");
    expect(failureOf("bad_message")).toBe("refused");
  });
});

describe("the inbox's sink", () => {
  function recordingFetch(answer: () => Response | Promise<Response>) {
    const posts: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      posts.push({ url: String(input), init });
      return answer();
    }) as typeof fetch;
    return { posts, fetchImpl };
  }

  it("posts a typed correction to the session's route, same-origin, with the page's time zone", async () => {
    const { posts, fetchImpl } = recordingFetch(() =>
      Response.json({
        sessionId: SESSION_ID,
        outcome: "corrected",
        proposalId: "01a1c6e2-0000-7000-8000-00000000c001",
        recorded: "now",
        lastSeq: 12,
      }),
    );
    const sink = routeCorrectionSink(fetchImpl);
    const outcome = await sink.correct({
      sessionId: SESSION_ID,
      proposalId: "01a1c6e2-0000-7000-8000-000000000001",
      field: "dueDate",
      questionId: "01a1c6e2-0000-7000-8000-00000000f001",
      text: "next Friday",
    });
    expect(outcome).toEqual({ ok: true });
    expect(posts).toHaveLength(1);
    const [post] = posts;
    expect(post?.url).toBe(`/api/sessions/${SESSION_ID}/corrections`);
    expect(post?.init?.method).toBe("POST");
    expect(post?.init?.credentials).toBe("same-origin");
    const body = JSON.parse(String(post?.init?.body));
    expect(body).toMatchObject({
      t: "correct",
      proposalId: "01a1c6e2-0000-7000-8000-000000000001",
      field: "dueDate",
      questionId: "01a1c6e2-0000-7000-8000-00000000f001",
      said: { input: "typed", text: "next Friday" },
    });
    expect(body.correctionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("says what the route refused, and “unavailable” when it can't be reached", async () => {
    const refused = routeCorrectionSink(
      recordingFetch(() =>
        Response.json({ error: "unreadable", message: "no date" }, { status: 422 }),
      ).fetchImpl,
    );
    const correction = {
      sessionId: SESSION_ID,
      proposalId: "01a1c6e2-0000-7000-8000-000000000001",
      field: "dueDate",
      questionId: null,
      text: "whenever",
    };
    expect(await refused.correct(correction)).toEqual({ ok: false, code: "unreadable" });
    const limited = routeCorrectionSink(
      recordingFetch(() => Response.json({ error: "too_many", message: "" }, { status: 429 }))
        .fetchImpl,
    );
    expect(await limited.correct(correction)).toEqual({ ok: false, code: "too_many" });
    const down = routeCorrectionSink((async () => {
      throw new TypeError("offline");
    }) as typeof fetch);
    expect(await down.correct(correction)).toEqual({ ok: false, code: "unavailable" });
  });

  it("skips a question with its id alone", async () => {
    const { posts, fetchImpl } = recordingFetch(() =>
      Response.json({
        sessionId: SESSION_ID,
        outcome: "skipped",
        proposalId: null,
        recorded: "now",
        lastSeq: 13,
      }),
    );
    const outcome = await routeCorrectionSink(fetchImpl).skip(
      SESSION_ID,
      "01a1c6e2-0000-7000-8000-00000000f001",
    );
    expect(outcome).toEqual({ ok: true });
    expect(JSON.parse(String(posts[0]?.init?.body))).toEqual({
      t: "skip",
      questionId: "01a1c6e2-0000-7000-8000-00000000f001",
    });
  });
});

describe("the tray's sink", () => {
  function writer(answer: CorrectionDelivery) {
    const sent: Parameters<CorrectionWriter["sendCorrection"]>[0][] = [];
    const skipped: string[] = [];
    const recording: CorrectionWriter = {
      sessionId: SESSION_ID,
      sendCorrection: async (input) => {
        sent.push(input);
        return answer;
      },
      sendFollowupSkip: async (questionId) => {
        skipped.push(questionId);
        return answer;
      },
    };
    return { recording, sent, skipped };
  }

  it("sends a typed correction's words on `correct` itself, never as an utterance", async () => {
    const { recording, sent } = writer({ ok: true, via: "socket" });
    const sink = socketCorrectionSink(recording);
    expect(sink.speech).toBeUndefined();
    const outcome = await sink.correct({
      sessionId: SESSION_ID,
      proposalId: "01a1c6e2-0000-7000-8000-000000000001",
      field: "target",
      questionId: null,
      text: "Pier Logistics",
    });
    expect(outcome).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      proposalId: "01a1c6e2-0000-7000-8000-000000000001",
      field: "target",
      typed: { text: "Pier Logistics" },
    });
    expect(sent[0]?.questionId).toBeUndefined();
    expect(sent[0]?.turnId).not.toBe(sent[0]?.typed?.utteranceId);
  });

  it("says SessionDO's limits as “too many”, and offers the microphone it was given", async () => {
    const { recording, skipped } = writer({ ok: false, code: "turn_limit" });
    const speech = { start: async () => ({ ok: true }) as const, finish: () => {} };
    const sink = socketCorrectionSink(recording, speech);
    expect(sink.speech).toBe(speech);
    expect(
      await sink.correct({
        sessionId: SESSION_ID,
        proposalId: "01a1c6e2-0000-7000-8000-000000000001",
        field: "amount",
        questionId: null,
        text: "forty thousand",
      }),
    ).toEqual({ ok: false, code: "too_many" });
    expect(await sink.skip(SESSION_ID, "01a1c6e2-0000-7000-8000-00000000f001")).toEqual({
      ok: false,
      code: "too_many",
    });
    expect(skipped).toEqual(["01a1c6e2-0000-7000-8000-00000000f001"]);
  });
});
