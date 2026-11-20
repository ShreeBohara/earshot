// The inbox's pure parts (Phase 5 spec WP5): grouping, the focus rules, the keys and their scope,
// what a card shows and sends, the editor's rules, snooze times, the optimistic sink's rollback,
// and the review clock on a fake clock (§4.8).
import type { ReviewInput, TargetV2 } from "@earshot/core";
import { describe, expect, it, vi } from "vitest";
import { cardModel } from "@/lib/inbox/card";
import { ReviewClock } from "@/lib/inbox/clock";
import { actionMessage, cardWords, failureMessage, nameFinder, shownValue } from "@/lib/inbox/copy";
import { editDiff, readEdit } from "@/lib/inbox/edit";
import { adjacentCard, focusAfterRemoval } from "@/lib/inbox/focus";
import {
  accountOf,
  cardOrder,
  inboxSections,
  isOpen,
  isSnoozed,
  sessionAccount,
} from "@/lib/inbox/groups";
import { inputOf } from "@/lib/inbox/input";
import {
  inboxKeyAction,
  isTextEntry,
  type KeyLike,
  readShortcutsSetting,
  SHORTCUTS_SETTING_KEY,
  writeShortcutsSetting,
} from "@/lib/inbox/keys";
import { decisionReview, reviewedState, seenOf, snoozeOf, undoReview } from "@/lib/inbox/review";
import {
  type Change,
  OptimisticReviews,
  type ReviewSink,
  routeSink,
  type SinkResult,
  singleChange,
  stateOf,
  withLocal,
} from "@/lib/inbox/sinks";
import { clockTime, dayWords, snoozeUntil, whenWords } from "@/lib/inbox/time";
import type { InboxEntity, InboxProposal, InboxSession } from "@/lib/inbox/types";
import { ManualClock } from "./support/manual-clock";

// ─── Fixtures ───────────────────────────────────────────────────────────────────────────────────

const UTTERANCE = "01a1c6e2-0000-7000-8000-00000000a001";
const SAID = "Met Dana at Acme Corp; move the Acme deal to proposal, and send the deck by Friday.";

function evidence(words: string) {
  const start = SAID.indexOf(words);
  if (start < 0) throw new Error(`"${words}" isn't said`);
  return {
    utteranceId: UTTERANCE,
    span: [start, start + words.length] as [number, number],
    audioMs: [0, 100] as [number, number],
    confidence: 0.9,
  };
}

const ENTITIES: Record<string, InboxEntity> = {
  co_acme: { id: "co_acme", kind: "company", name: "Acme Corp", accountId: "co_acme", values: {} },
  co_akme: {
    id: "co_akme",
    kind: "company",
    name: "Akme Dynamics",
    accountId: "co_akme",
    values: {},
  },
  co_pier: {
    id: "co_pier",
    kind: "company",
    name: "Pier Logistics",
    accountId: "co_pier",
    values: {},
  },
  ct_dana: {
    id: "ct_dana",
    kind: "contact",
    name: "Dana Lee",
    accountId: "co_acme",
    values: { title: "VP of Operations" },
  },
  ct_dani: { id: "ct_dani", kind: "contact", name: "Dana Li", accountId: "co_akme", values: {} },
  deal_acme: {
    id: "deal_acme",
    kind: "deal",
    name: "Acme Corp - Platform",
    accountId: "co_acme",
    values: { stage: "appointmentscheduled", amount: 40_000 },
  },
};
const QUOTES = { [UTTERANCE]: SAID };

function target(overrides: Partial<TargetV2> = {}): TargetV2 {
  return {
    decision: "linked",
    entityId: "co_acme",
    kind: "company",
    basis: "exact",
    p: 0.99,
    mention: { quote: "Acme Corp", evidence: evidence("Acme Corp") },
    company: null,
    candidates: [{ entityId: "co_acme", p: 0.99 }],
    ...overrides,
  };
}

let next = 0;
function proposal(overrides: Partial<InboxProposal> = {}): InboxProposal {
  next += 1;
  return {
    proposalId: `01a1c6e2-0000-7000-8000-${next.toString().padStart(12, "0")}`,
    type: "task",
    targetEntityId: "co_acme",
    target: target(),
    status: "proposed",
    fields: { title: { value: "Send the deck", evidence: evidence("send the deck") } },
    riskFlags: [],
    conflicts: [],
    supersedes: null,
    supersededBy: null,
    snoozedUntil: null,
    seq: next,
    ts: "2026-11-20T15:00:00.000Z",
    review: null,
    ...overrides,
  };
}

const ASK = target({
  decision: "ask",
  entityId: null,
  kind: "contact",
  basis: "sound",
  p: 0.5,
  mention: { quote: "Dana", evidence: evidence("Dana") },
  candidates: [
    { entityId: "ct_dani", p: 0.5 },
    { entityId: "ct_dana", p: 0.4 },
    { entityId: null, p: 0.1 },
  ],
});

function session(overrides: Partial<InboxSession> = {}): InboxSession {
  return {
    sessionId: "01a1c6e2-0000-7000-8000-0000000000aa",
    startedAt: "2026-11-20T15:00:00.000Z",
    endedAt: "2026-11-20T15:02:00.000Z",
    sealedAt: "2026-11-20T15:03:00.000Z",
    focusEntityId: null,
    proposals: [],
    ...overrides,
  };
}

const NOW = Date.parse("2026-11-20T16:00:00.000Z");

// ─── Grouping ───────────────────────────────────────────────────────────────────────────────────

describe("the loader's grouping", () => {
  it("puts each sealed debrief's open cards in a group, and the rest in their sections", () => {
    const open = proposal();
    const approved = proposal({
      status: "approved",
      review: {
        reviewId: "01a1c6e2-0000-7000-8000-00000000ff01",
        decision: "approved",
        target: null,
        mode: "single",
        batchId: null,
        undoes: null,
        syncEligibleAt: "2026-11-20T15:30:30.000Z",
        ts: "2026-11-20T15:30:00.000Z",
      },
    });
    const snoozed = proposal({ snoozedUntil: "2026-11-21T09:00:00.000Z" });
    const woken = proposal({ snoozedUntil: "2026-11-20T15:30:00.000Z" });
    const replaced = proposal({ status: "superseded", supersededBy: open.proposalId });
    const sealed = session({ proposals: [open, approved, snoozed, woken, replaced] });
    const finishing = session({
      sessionId: "01a1c6e2-0000-7000-8000-0000000000bb",
      sealedAt: null,
      proposals: [proposal(), proposal()],
    });
    const sections = inboxSections([finishing, sealed], ENTITIES, NOW);
    expect(sections.review).toHaveLength(1);
    expect(cardOrder(sections.review)).toEqual([[open.proposalId, woken.proposalId]]);
    expect(sections.openCount).toBe(2);
    expect(sections.reviewed.map((item) => item.proposal.proposalId)).toEqual([
      approved.proposalId,
    ]);
    expect(sections.snoozed.map((item) => item.proposal.proposalId)).toEqual([snoozed.proposalId]);
    expect(sections.finishing).toEqual([
      expect.objectContaining({ sessionId: finishing.sessionId, waiting: 2 }),
    ]);
    expect(isSnoozed(snoozed, NOW)).toBe(true);
    expect(isOpen(woken, NOW)).toBe(true);
  });

  it("heads a group by the focus account, else the account its cards name most", () => {
    const toAcme = proposal();
    const toDeal = proposal({ target: target({ entityId: "deal_acme", kind: "deal" }) });
    const toPier = proposal({ target: target({ entityId: "co_pier" }) });
    expect(sessionAccount(session({ proposals: [toPier, toAcme, toDeal] }), ENTITIES)).toBe(
      "co_acme",
    );
    expect(
      sessionAccount(session({ focusEntityId: "co_pier", proposals: [toAcme] }), ENTITIES),
    ).toBe("co_pier");
    // A tie goes to the first named; no account at all is none.
    expect(sessionAccount(session({ proposals: [toPier, toAcme] }), ENTITIES)).toBe("co_pier");
    expect(
      sessionAccount(
        session({
          proposals: [proposal({ target: target({ decision: "none", entityId: null }) })],
        }),
        ENTITIES,
      ),
    ).toBeNull();
  });

  it("names a question's account only when every record it offers belongs to one", () => {
    expect(accountOf(proposal({ target: ASK }), ENTITIES)).toBeNull();
    const sameAccount = target({
      ...ASK,
      candidates: [
        { entityId: "ct_dana", p: 0.6 },
        { entityId: "deal_acme", p: 0.3 },
      ],
    });
    expect(accountOf(proposal({ target: sameAccount }), ENTITIES)).toBe("co_acme");
    const saidWith = target({
      decision: "new",
      entityId: null,
      company: { quote: "Acme Corp", evidence: evidence("Acme Corp"), entityId: "co_acme" },
      candidates: [],
    });
    expect(accountOf(proposal({ target: saidWith }), ENTITIES)).toBe("co_acme");
  });

  it("puts a sub-heading per account only when a debrief's cards name more than one", () => {
    const acme = proposal();
    const pier = proposal({ target: target({ entityId: "co_pier" }) });
    const unnamed = proposal({ target: ASK });
    const [split] = inboxSections(
      [session({ proposals: [unnamed, acme, pier] })],
      ENTITIES,
      NOW,
    ).review;
    expect(split?.byAccount).toBe(true);
    expect(split?.accounts.map((account) => account.accountId)).toEqual([
      "co_acme",
      "co_pier",
      null,
    ]);
    // The cards walk in the order they're shown, by account.
    expect(cardOrder(split ? [split] : [])).toEqual([
      [acme.proposalId, pier.proposalId, unnamed.proposalId],
    ]);
    const [whole] = inboxSections([session({ proposals: [unnamed, acme] })], ENTITIES, NOW).review;
    expect(whole?.byAccount).toBe(false);
    expect(whole?.accounts).toHaveLength(1);
  });
});

// ─── Focus ──────────────────────────────────────────────────────────────────────────────────────

describe("the focus rules", () => {
  const groups = [["a1", "a2", "a3"], ["b1"], ["c1", "c2"]];

  it("moves to the next card in the group, or the previous if it was the last", () => {
    expect(focusAfterRemoval(groups, "a1")).toEqual({ kind: "card", id: "a2" });
    expect(focusAfterRemoval(groups, "a3")).toEqual({ kind: "card", id: "a2" });
    expect(focusAfterRemoval(groups, "c2")).toEqual({ kind: "card", id: "c1" });
  });

  it("then to the next group's first card, then the group before's last", () => {
    expect(focusAfterRemoval(groups, "b1")).toEqual({ kind: "card", id: "c1" });
    expect(focusAfterRemoval([["a1", "a2"], ["c1"]], "c1")).toEqual({ kind: "card", id: "a2" });
  });

  it("then to All caught up: never to nothing", () => {
    expect(focusAfterRemoval([["only"]], "only")).toEqual({ kind: "caught-up" });
    expect(focusAfterRemoval([], "gone")).toEqual({ kind: "caught-up" });
    expect(focusAfterRemoval([["a1"]], "unknown")).toEqual({ kind: "card", id: "a1" });
  });

  it("walks j and k across groups without wrapping", () => {
    expect(adjacentCard(groups, "a3", 1)).toBe("b1");
    expect(adjacentCard(groups, "b1", -1)).toBe("a3");
    expect(adjacentCard(groups, "c2", 1)).toBeNull();
    expect(adjacentCard(groups, "a1", -1)).toBeNull();
    expect(adjacentCard(groups, null, 1)).toBe("a1");
    expect(adjacentCard(groups, null, -1)).toBe("c2");
    expect(adjacentCard([], null, 1)).toBeNull();
  });
});

// ─── Keys ───────────────────────────────────────────────────────────────────────────────────────

function key(value: string, overrides: Partial<KeyLike> = {}): KeyLike {
  return {
    key: value,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    repeat: false,
    target: { tagName: "ARTICLE" },
    ...overrides,
  };
}

describe("the shortcuts", () => {
  it("reads each key as its action, by its first letter, and digits as choices", () => {
    expect(inboxKeyAction(key("j"))).toEqual({ kind: "move", step: 1 });
    expect(inboxKeyAction(key("k"))).toEqual({ kind: "move", step: -1 });
    expect(inboxKeyAction(key("a"))).toEqual({ kind: "accept" });
    expect(inboxKeyAction(key("E"))).toEqual({ kind: "edit" });
    expect(inboxKeyAction(key("r"))).toEqual({ kind: "reject" });
    expect(inboxKeyAction(key("s"))).toEqual({ kind: "snooze" });
    expect(inboxKeyAction(key("c"))).toEqual({ kind: "correct" });
    expect(inboxKeyAction(key("u"))).toEqual({ kind: "undo" });
    expect(inboxKeyAction(key("?"))).toEqual({ kind: "help" });
    expect(inboxKeyAction(key("2"))).toEqual({ kind: "choose", index: 1 });
    expect(inboxKeyAction(key("4"))).toEqual({ kind: "choose", index: 3 });
    expect(inboxKeyAction(key("5"))).toBeNull();
  });

  it("binds no Space, no z, no ⌘↵, and nothing with a modifier", () => {
    expect(inboxKeyAction(key(" "))).toBeNull();
    expect(inboxKeyAction(key("z"))).toBeNull();
    expect(inboxKeyAction(key("Enter", { metaKey: true }))).toBeNull();
    expect(inboxKeyAction(key("a", { metaKey: true }))).toBeNull();
    expect(inboxKeyAction(key("a", { ctrlKey: true }))).toBeNull();
    expect(inboxKeyAction(key("a", { altKey: true }))).toBeNull();
    expect(inboxKeyAction(key("a", { isComposing: true }))).toBeNull();
  });

  it("never acts from a text field, and repeats only j and k", () => {
    for (const target of [
      { tagName: "INPUT", type: "text" },
      { tagName: "INPUT", type: "date" },
      { tagName: "INPUT" },
      { tagName: "TEXTAREA" },
      { tagName: "SELECT" },
      { tagName: "DIV", isContentEditable: true },
    ]) {
      expect(isTextEntry(target)).toBe(true);
      expect(inboxKeyAction(key("a", { target }))).toBeNull();
    }
    expect(isTextEntry({ tagName: "INPUT", type: "radio" })).toBe(false);
    expect(isTextEntry({ tagName: "BUTTON" })).toBe(false);
    expect(inboxKeyAction(key("a", { repeat: true }))).toBeNull();
    expect(inboxKeyAction(key("j", { repeat: true }))).toEqual({ kind: "move", step: 1 });
  });

  it("are on unless this device turned them off", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (name: string) => store.get(name) ?? null,
      setItem: (name: string, value: string) => void store.set(name, value),
    };
    expect(readShortcutsSetting(storage)).toBe(true);
    const events = new EventTarget();
    const heard = vi.fn();
    events.addEventListener("earshot:inbox-shortcuts", heard);
    writeShortcutsSetting(false, { storage, events });
    expect(store.get(SHORTCUTS_SETTING_KEY)).toBe("off");
    expect(readShortcutsSetting(storage)).toBe(false);
    expect(heard).toHaveBeenCalledOnce();
    writeShortcutsSetting(true, { storage });
    expect(readShortcutsSetting(storage)).toBe(true);
    // No storage, or storage that throws: on.
    expect(readShortcutsSetting(null)).toBe(true);
    expect(
      readShortcutsSetting({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe(true);
  });

  it("tells keys, pointers, and touch apart", () => {
    expect(inputOf({ type: "keydown" })).toBe("keyboard");
    expect(inputOf({ type: "click", detail: 0, nativeEvent: { pointerType: "" } })).toBe(
      "keyboard",
    );
    expect(inputOf({ type: "click", detail: 1, nativeEvent: { pointerType: "mouse" } })).toBe(
      "pointer",
    );
    expect(inputOf({ type: "click", detail: 1, nativeEvent: { pointerType: "touch" } })).toBe(
      "touch",
    );
    expect(inputOf(null)).toBe("keyboard");
  });
});

// ─── The card ───────────────────────────────────────────────────────────────────────────────────

describe("what a card shows", () => {
  it("is plain when unmarked: no line, no description, no chooser", () => {
    const model = cardModel(proposal(), ENTITIES, QUOTES);
    expect(model.tier.tier).toBe("none");
    expect(model.firstPerson).toBeNull();
    expect(model.description).toBeNull();
    expect(model.chooser).toBeNull();
    expect(model.notes).toEqual([]);
    expect(model.fields[0]).toMatchObject({
      label: "Title",
      value: "Send the deck",
      heard: "send the deck",
    });
  });

  it("gives a quiet card its note and no color, and a near link its name note", () => {
    const quiet = cardModel(
      proposal({
        riskFlags: [{ kind: "implied_target", field: "target" }],
        target: target({ basis: "focus", mention: null }),
      }),
      ENTITIES,
      QUOTES,
    );
    expect(quiet.tier.tier).toBe("quiet");
    expect(quiet.notes).toEqual(["Open account assumed"]);
    expect(quiet.firstPerson).toBeNull();
    const named = cardModel(
      proposal({
        riskFlags: [{ kind: "link_uncertain", field: "target" }],
        target: target({ basis: "context", p: 0.9 }),
      }),
      ENTITIES,
      QUOTES,
    );
    expect(named.nameNote).toBe("matched in context");
    expect(named.notes).toEqual([]);
  });

  it("numbers a question's records, with their names, accounts, and odds, as its correction", () => {
    const model = cardModel(proposal({ target: ASK, type: "contact" }), ENTITIES, QUOTES);
    expect(model.tier.tier).toBe("loud");
    expect(model.firstPerson?.lead).toBe("I'm not sure who you meant.");
    expect(model.description).toBe("Contact, Dana Li, needs a check: I'm not sure who you meant.");
    expect(model.choosesRecord).toBe(true);
    expect(model.acceptable).toBe("choose");
    expect(model.chooser?.options).toEqual([
      { kind: "record", entityId: "ct_dani", label: "Dana Li, Akme Dynamics", detail: "50%" },
      { kind: "record", entityId: "ct_dana", label: "Dana Lee, Acme Corp", detail: "40%" },
      { kind: "record", entityId: null, label: "A new record", detail: "10%" },
    ]);
    expect(model.correction).toEqual([]);
  });

  it("offers a linked card's other records only in the correction panel", () => {
    const linked = proposal({
      target: target({
        candidates: [
          { entityId: "co_acme", p: 0.9 },
          { entityId: "co_akme", p: 0.08 },
          { entityId: null, p: 0.02 },
        ],
      }),
    });
    const model = cardModel(linked, ENTITIES, QUOTES);
    expect(model.chooser).toBeNull();
    expect(model.correction.map((option) => option.kind === "record" && option.entityId)).toEqual([
      "co_acme",
      "co_akme",
      null,
    ]);
    expect(model.correction[0]?.detail).toBe("90%, the current record");
  });

  it("offers a field's two readings when the witnesses disagree on it", () => {
    const conflicted = proposal({
      type: "contact",
      target: target({ entityId: "ct_dana", kind: "contact" }),
      fields: { name: { value: "Dana", evidence: evidence("Dana") } },
      riskFlags: [{ kind: "witness_conflict", field: "name" }],
      conflicts: [
        {
          field: "name",
          biased: { text: "Dana", evidence: evidence("Dana") },
          unbiased: { text: "Donna", utteranceId: UTTERANCE, audioMs: [0, 100] },
        },
      ],
    });
    const model = cardModel(conflicted, ENTITIES, QUOTES);
    expect(model.chooser?.label).toBe("Which did you say?");
    expect(model.chooser?.options.map((option) => option.label)).toEqual(["“Dana”", "“Donna”"]);
    expect(model.chooser?.options.map((option) => option.kind === "value" && option.keep)).toEqual([
      true,
      false,
    ]);
  });

  it("shows an update's CRM value as before, and can't accept a card with no record", () => {
    const update = proposal({
      type: "deal_update",
      target: target({ entityId: "deal_acme", kind: "deal" }),
      fields: {
        stage: { value: "proposal", evidence: evidence("proposal") },
        amount: { value: 40_000, evidence: evidence("Acme deal") },
      },
    });
    const model = cardModel(update, ENTITIES, QUOTES);
    expect(model.fields.map(({ before, value, changes }) => ({ before, value, changes }))).toEqual([
      { before: "Appointment scheduled", value: "proposal", changes: true },
      { before: "$40,000", value: "$40,000", changes: false },
    ]);
    const none = cardModel(
      proposal({
        target: target({ decision: "none", entityId: null, candidates: [] }),
        riskFlags: [{ kind: "unsupported", field: "target" }],
      }),
      ENTITIES,
      QUOTES,
    );
    expect(none.acceptable).toBe("no_record");
  });
});

// ─── What a card sends ──────────────────────────────────────────────────────────────────────────

describe("what a card sends", () => {
  it("records what the reviewer saw, the clock's timing, the input, and the surface", () => {
    const ask = proposal({ target: ASK, type: "contact" });
    const review = decisionReview({
      proposal: ask,
      entities: ENTITIES,
      decision: "approved",
      target: { entityId: "ct_dana" },
      timing: { decisionMs: 1200, handlingMs: 1250 },
      input: "keyboard",
      reviewId: "01a1c6e2-0000-7000-8000-00000000f001",
    });
    expect(review).toEqual({
      reviewId: "01a1c6e2-0000-7000-8000-00000000f001",
      proposalId: ask.proposalId,
      decision: "approved",
      target: { entityId: "ct_dana" },
      mode: "single",
      batchId: null,
      policy: null,
      undoes: null,
      reason: null,
      seen: {
        tier: "loud",
        fields: { title: { proposed: "Send the deck" } },
        target: { entityId: null, offered: ["ct_dani", "ct_dana", null] },
        relinked: null,
        clip: "none",
      },
      timing: { decisionMs: 1200, handlingMs: 1250 },
      input: "keyboard",
      surface: "inbox",
    } satisfies ReviewInput);
  });

  it("records an update's CRM value as base, and an edit's diff", () => {
    const update = proposal({
      type: "deal_update",
      target: target({ entityId: "deal_acme", kind: "deal" }),
      fields: { stage: { value: "proposal", evidence: evidence("proposal") } },
    });
    expect(seenOf(update, ENTITIES).fields).toEqual({
      stage: { proposed: "proposal", base: "appointmentscheduled" },
    });
    const review = decisionReview({
      proposal: update,
      entities: ENTITIES,
      decision: "edited",
      editDiff: { stage: { before: "proposal", after: "contractsent" } },
      timing: { decisionMs: 900, handlingMs: 4000 },
      input: "pointer",
    });
    expect(review.editDiff).toEqual({ stage: { before: "proposal", after: "contractsent" } });
    expect(review.target).toBeNull();
    const rejected = decisionReview({
      proposal: update,
      entities: ENTITIES,
      decision: "rejected",
      target: { entityId: "deal_acme" },
      timing: { decisionMs: 1, handlingMs: 1 },
      input: "touch",
    });
    // A rejection chooses no record.
    expect(rejected.target).toBeNull();
    expect(rejected.input).toBe("touch");
  });

  it("undoes with a reopen naming the review, and snoozes or wakes by id", () => {
    const reopened = undoReview({
      proposal: proposal(),
      entities: ENTITIES,
      undoes: "01a1c6e2-0000-7000-8000-00000000f001",
      input: "keyboard",
    });
    expect(reopened).toMatchObject({
      decision: "reopened",
      undoes: "01a1c6e2-0000-7000-8000-00000000f001",
      reason: "undo",
      target: null,
      mode: "single",
      timing: { decisionMs: 0, handlingMs: 0 },
    });
    const snooze = snoozeOf("p1", new Date("2026-11-21T09:00:00.000Z"), "s1");
    expect(snooze).toEqual({ snoozeId: "s1", proposalId: "p1", until: "2026-11-21T09:00:00.000Z" });
    expect(snoozeOf("p1", null, "s2").until).toBeNull();
    const state = reviewedState(reopened, new Date(NOW), 30_000);
    expect(state.status).toBe("proposed");
    expect(state.review.syncEligibleAt).toBeNull();
  });

  it("says each action once, and each failure", () => {
    expect(actionMessage({ kind: "accepted", what: "task for Acme Corp" }, 4, true)).toBe(
      "Accepted: task for Acme Corp. 4 left. Press U to undo.",
    );
    expect(actionMessage({ kind: "rejected", what: "note" }, 0, false)).toBe(
      "Rejected: note. All caught up.",
    );
    expect(actionMessage({ kind: "restored", what: "note" }, 2, true)).toBe(
      "Back for review: note. 2 left.",
    );
    expect(failureMessage("review", "task for Acme Corp", "stale")).toBe(
      "Couldn't record your review of the task for Acme Corp: it changed since the page loaded. Reload to see it as it is now.",
    );
    const nameOf = nameFinder(ENTITIES);
    expect(cardWords(proposal(), nameOf)).toBe("task for Acme Corp");
    expect(cardWords(proposal({ target: ASK }), nameOf, { entityId: "ct_dana" })).toBe(
      "task for Dana Lee",
    );
    expect(cardWords(proposal({ target: ASK }), nameOf)).toBe("task");
    expect(shownValue("stage", "closedwon")).toBe("Closed won");
    expect(shownValue("amount", 112_000)).toBe("$112,000");
    expect(shownValue("dueDate", "2026-11-24")).toBe("November 24");
  });
});

// ─── The editor ─────────────────────────────────────────────────────────────────────────────────

describe("the editor's rules", () => {
  const deal = proposal({
    type: "deal_update",
    fields: {
      amount: { value: 40_000, evidence: evidence("Acme deal") },
      closeDate: { value: "2026-12-01", evidence: evidence("Friday") },
      stage: { value: "proposal", evidence: evidence("proposal") },
    },
  });

  it("reads numbers, days, and words, and keeps only what changed", () => {
    const result = readEdit(deal, {
      amount: "$45,000",
      closeDate: "2026-12-01",
      stage: "proposal",
    });
    expect(result).toEqual({
      ok: true,
      values: { amount: 45_000, closeDate: "2026-12-01", stage: "proposal" },
    });
    if (result.ok) {
      expect(editDiff(deal, result.values)).toEqual({ amount: { before: 40_000, after: 45_000 } });
    }
    expect(
      readEdit(deal, { amount: "", closeDate: "2026-12-01", stage: "proposal" }),
    ).toMatchObject({
      ok: true,
      values: { amount: null },
    });
  });

  it("ties each error to its field, and refuses an edit that changes nothing", () => {
    expect(readEdit(deal, { amount: "a lot", closeDate: "2026-02-30", stage: "x" })).toEqual({
      ok: false,
      errors: {
        amount: "Enter a number, like 40000.",
        closeDate: "Enter a date, like 2026-11-27.",
      },
      formError: null,
    });
    expect(
      readEdit(deal, { amount: "40000", closeDate: "2026-12-01", stage: " proposal " }),
    ).toEqual({
      ok: false,
      errors: {},
      formError: "Nothing changed. Change a value to save it, or press Esc to cancel.",
    });
  });
});

// ─── Times ──────────────────────────────────────────────────────────────────────────────────────

describe("snooze times", () => {
  it("wakes tomorrow at 9:00, in three hours, or next Monday at 9:00, in local time", () => {
    const thursday = new Date(2026, 10, 19, 16, 30); // Thu 19 Nov 2026, 4:30 pm local
    expect(snoozeUntil("tomorrow", thursday)).toEqual(new Date(2026, 10, 20, 9, 0));
    expect(snoozeUntil("hours", thursday)).toEqual(new Date(2026, 10, 19, 19, 30));
    expect(snoozeUntil("monday", thursday)).toEqual(new Date(2026, 10, 23, 9, 0));
    const monday = new Date(2026, 10, 23, 8, 0);
    expect(snoozeUntil("monday", monday)).toEqual(new Date(2026, 10, 30, 9, 0));
    const sunday = new Date(2026, 10, 22, 22, 0);
    expect(snoozeUntil("monday", sunday)).toEqual(new Date(2026, 10, 23, 9, 0));
  });

  it("says days the way the inbox does", () => {
    const now = new Date(2026, 10, 19, 16, 30);
    expect(dayWords(new Date(2026, 10, 19, 9, 0), now)).toBe("today");
    expect(dayWords(new Date(2026, 10, 18, 9, 0), now)).toBe("yesterday");
    expect(dayWords(new Date(2026, 10, 20, 9, 0), now)).toBe("tomorrow");
    expect(dayWords(new Date(2026, 10, 16, 9, 0), now)).toBe("Monday");
    expect(dayWords(new Date(2026, 9, 1, 9, 0), now)).toBe("Oct 1");
    expect(dayWords(new Date(2025, 9, 1, 9, 0), now)).toBe("Oct 1, 2025");
    expect(clockTime(new Date(2026, 10, 19, 14, 14))).toBe("2:14 pm");
    expect(whenWords(new Date(2026, 10, 20, 9, 0), now)).toBe("tomorrow, 9:00 am");
  });
});

// ─── The sink ───────────────────────────────────────────────────────────────────────────────────

/** A sink whose answers the test releases one at a time. */
function heldSink() {
  const sent: { sessionId: string; request: Change["request"]; answer: (r: SinkResult) => void }[] =
    [];
  const sink: ReviewSink = {
    send: (sessionId, request) =>
      new Promise<SinkResult>((resolve) => sent.push({ sessionId, request, answer: resolve })),
  };
  return { sink, sent };
}

function change(open: InboxProposal, status: InboxProposal["status"], reviewId: string): Change {
  return singleChange(
    "s1",
    open.proposalId,
    {
      previous: stateOf(open),
      next: {
        status,
        snoozedUntil: null,
        review: {
          reviewId,
          decision: status === "proposed" ? "reopened" : (status as "approved"),
          target: null,
          mode: "single",
          batchId: null,
          undoes: null,
          syncEligibleAt: null,
          ts: "2026-11-20T15:00:00.000Z",
        },
      },
    },
    { reviews: [], snoozes: [] },
  );
}

describe("the sink's rollback", () => {
  it("applies a change at once, and sends changes one at a time, in order", async () => {
    const { sink, sent } = heldSink();
    const store = new OptimisticReviews(sink);
    const a = proposal();
    const b = proposal();
    const first = store.apply(change(a, "approved", "r1"));
    const second = store.apply(change(b, "rejected", "r2"));
    expect(withLocal(a, store.overlay()).status).toBe("approved");
    expect(withLocal(b, store.overlay()).status).toBe("rejected");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(store.queued()).toBe(2);
    sent[0]?.answer({ ok: true });
    await expect(first).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    sent[1]?.answer({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    expect(store.queued()).toBe(0);
  });

  it("brings a refused card back as it was, drops what built on it, and reports it once", async () => {
    const { sink, sent } = heldSink();
    const onFailure = vi.fn();
    const store = new OptimisticReviews(sink, { onFailure });
    const a = proposal();
    const accepted = store.apply(change(a, "approved", "r1"));
    // An undo of that review, queued behind it.
    const undone = store.apply(change({ ...a, status: "approved" }, "proposed", "r2"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    sent[0]?.answer({ ok: false, reason: "stale" });
    await expect(accepted).resolves.toEqual({ ok: false, reason: "stale" });
    await expect(undone).resolves.toEqual({ ok: false, reason: "stale" });
    expect(sent).toHaveLength(1);
    expect(withLocal(a, store.overlay())).toMatchObject({ status: "proposed", review: null });
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ reason: "stale" });
  });

  it("forgets its own state once a load holds it", async () => {
    const store = new OptimisticReviews({ send: async () => ({ ok: true }) });
    const a = proposal();
    const applied = change(a, "approved", "r1");
    await store.apply(applied);
    store.reconcile([{ ...a, status: "proposed" }]);
    expect(store.overlay().has(a.proposalId)).toBe(true);
    store.reconcile([{ ...a, ...applied.items[0]?.next }]);
    expect(store.overlay().has(a.proposalId)).toBe(false);
  });

  // Codex's review of #59: SessionDO reopens a just-approved card after a late flag. If that reopen
  // overtakes the approval before the tray reconciles (a deferred list can skip the approved state
  // between them), the page's approval mustn't keep hiding the reopened card.
  it("forgets its own state when a later review reverses it, even if the approval never showed", async () => {
    const store = new OptimisticReviews({ send: async () => ({ ok: true }) });
    const a = proposal();
    await store.apply(change(a, "approved", "r1"));
    const reopened: InboxProposal = {
      ...a,
      status: "proposed",
      review: {
        reviewId: "sys1",
        decision: "reopened",
        target: null,
        mode: "system",
        batchId: null,
        undoes: "r1",
        syncEligibleAt: null,
        ts: "2026-11-20T15:00:05.000Z",
      },
    };
    store.reconcile([reopened]);
    expect(store.overlay().has(a.proposalId)).toBe(false);
    expect(withLocal(reopened, store.overlay()).status).toBe("proposed");
  });

  it("forgets its own state once the session's events reach the seq its write reached, not before", async () => {
    const store = new OptimisticReviews({ send: async () => ({ ok: true, seq: 12 }) });
    const a = proposal();
    const written = decisionReview({
      proposal: a,
      entities: {},
      decision: "approved",
      timing: { decisionMs: 800, handlingMs: 800 },
      input: "keyboard",
      reviewId: "r1",
    });
    // The write lands at seq 12, for the card its request names.
    await store.apply({
      ...change(a, "approved", "r1"),
      request: { reviews: [written], snoozes: [] },
    });
    const review = (reviewId: string, seq: number): InboxProposal["review"] => ({
      reviewId,
      decision: "approved",
      target: null,
      mode: "single",
      batchId: null,
      undoes: null,
      syncEligibleAt: null,
      ts: "2026-11-20T15:00:00.000Z",
      seq,
    });
    // An older review, from before the write: the page's state stands.
    store.reconcile([{ ...a, status: "approved", review: review("r0", 7) }]);
    expect(store.overlay().has(a.proposalId)).toBe(true);
    // A review at or past the write's seq, whatever it is: the events hold the write and more.
    store.reconcile([{ ...a, status: "approved", review: review("r9", 15) }]);
    expect(store.overlay().has(a.proposalId)).toBe(false);
  });

  it("keeps its state while the write is still on its way, whatever the events say", async () => {
    const { sink, sent } = heldSink();
    const store = new OptimisticReviews(sink);
    const a = proposal();
    const landed = store.apply(change(a, "approved", "r1"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    store.reconcile([
      {
        ...a,
        review: {
          reviewId: "sys1",
          decision: "reopened",
          target: null,
          mode: "system",
          batchId: null,
          undoes: "r1",
          syncEligibleAt: null,
          ts: "2026-11-20T15:00:05.000Z",
          seq: 99,
        },
      },
    ]);
    expect(store.overlay().has(a.proposalId)).toBe(true);
    sent[0]?.answer({ ok: true, seq: 12 });
    await expect(landed).resolves.toEqual({ ok: true });
  });

  it("posts to the review route and reads its refusals", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const answers: Response[] = [
      Response.json({ sessionId: "s1", reviews: [], snoozes: [], lastSeq: 9 }),
      Response.json({ error: "stale", message: "x" }, { status: 409 }),
      Response.json({ error: "not_sealed", message: "x" }, { status: 409 }),
      Response.json({ error: "audit_unavailable", message: "x" }, { status: 503 }),
      new Response("nope", { status: 500 }),
    ];
    const sink = routeSink(async (url, init) => {
      calls.push({ url: String(url), init });
      const answer = answers.shift();
      if (!answer) throw new TypeError("offline");
      return answer;
    });
    const request = { reviews: [], snoozes: [snoozeOf("p1", null, "s9")] };
    // The seq the write reached, for reconciling against the session's events.
    expect(await sink.send("s1", request)).toEqual({ ok: true, seq: 9 });
    expect(calls[0]?.url).toBe("/api/sessions/s1/reviews");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(request);
    expect(await sink.send("s1", request)).toEqual({ ok: false, reason: "stale" });
    expect(await sink.send("s1", request)).toEqual({ ok: false, reason: "not_sealed" });
    expect(await sink.send("s1", request)).toEqual({ ok: false, reason: "unavailable" });
    expect(await sink.send("s1", request)).toEqual({ ok: false, reason: "failed" });
    expect(await sink.send("s1", request)).toEqual({ ok: false, reason: "failed" });
  });
});

// ─── The review clock ───────────────────────────────────────────────────────────────────────────

describe("the review clock", () => {
  function clockOn(manual: ManualClock) {
    const clock = new ReviewClock({
      now: () => manual.now(),
      setTimeout: (callback, ms) => manual.setTimeout(callback, ms),
      clearTimeout: (handle) => manual.clearTimeout(handle),
    });
    clock.input();
    return clock;
  }

  it("starts only when the active card is half visible, on a visible page", async () => {
    const manual = new ManualClock();
    const clock = clockOn(manual);
    clock.setActive("p1");
    await manual.advance(1_000);
    expect(clock.elapsed("p1")).toBe(0);
    clock.setVisible("p1", true);
    await manual.advance(1_500);
    expect(clock.elapsed("p1")).toBe(1_500);
    // Another card active: p1 stops; it carries on when it's back.
    clock.setVisible("p2", true);
    clock.setActive("p2");
    await manual.advance(700);
    expect(clock.elapsed("p1")).toBe(1_500);
    expect(clock.elapsed("p2")).toBe(700);
    clock.setActive("p1");
    await manual.advance(500);
    expect(clock.elapsed("p1")).toBe(2_000);
  });

  it("pauses while the page or the card is hidden", async () => {
    const manual = new ManualClock();
    const clock = clockOn(manual);
    clock.setActive("p1");
    clock.setVisible("p1", true);
    await manual.advance(1_000);
    clock.setPageVisible(false);
    clock.input();
    await manual.advance(5_000);
    expect(clock.elapsed("p1")).toBe(1_000);
    clock.setPageVisible(true);
    await manual.advance(1_000);
    clock.setVisible("p1", false);
    await manual.advance(2_000);
    expect(clock.elapsed("p1")).toBe(2_000);
    expect(clock.running("p1")).toBe(false);
  });

  it("pauses after 30 s with no input, counting the 30 s, until the next input", async () => {
    const manual = new ManualClock();
    const clock = clockOn(manual);
    clock.setActive("p1");
    clock.setVisible("p1", true);
    await manual.advance(10_000);
    clock.input();
    await manual.advance(45_000);
    // 10 s, then 30 s more before it went quiet; the last 15 s don't count.
    expect(clock.elapsed("p1")).toBe(40_000);
    expect(clock.running("p1")).toBe(false);
    clock.input();
    await manual.advance(2_000);
    expect(clock.elapsed("p1")).toBe(42_000);
  });

  it("stops at the decision, and hands both times over at the commit", async () => {
    const manual = new ManualClock();
    const clock = clockOn(manual);
    clock.setActive("p1");
    clock.setVisible("p1", true);
    await manual.advance(1_200);
    clock.decide("p1"); // e: the editor opens
    await manual.advance(800);
    clock.decide("p1"); // a later key doesn't move it
    await manual.advance(2_000);
    expect(clock.commit("p1")).toEqual({ decisionMs: 1_200, handlingMs: 4_000 });
    // The card starts afresh: an undo brings it back at zero.
    await manual.advance(500);
    expect(clock.elapsed("p1")).toBe(500);
    // A key that decides and commits at once gives one time twice.
    expect(clock.commit("p1")).toEqual({ decisionMs: 500, handlingMs: 500 });
    clock.dispose();
    expect(manual.pending).toBe(0);
  });
});
