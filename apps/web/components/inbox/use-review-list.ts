"use client";

import {
  type FieldEdit,
  type FieldValue,
  PROPOSAL_TYPE_FIELDS,
  type ReviewSurface,
  UNDO_WINDOW_MS,
} from "@earshot/core";
import type { FollowupView } from "@earshot/events";
import { toast } from "@earshot/ui/components/toast";
import {
  type KeyboardEvent,
  type Ref,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { fieldLabel } from "@/lib/capture/copy";
import {
  type BatchPlan,
  batchItems,
  batchPlan,
  batchReviews,
  batchUndoReviews,
} from "@/lib/inbox/batch";
import { type CardModel, type ChoiceOption, cardModel } from "@/lib/inbox/card";
import {
  type ActionMessage,
  actionMessage,
  batchFailureMessage,
  batchMessage,
  batchRestoredMessage,
  cardWords,
  chooseHint,
  failureMessage,
  KEY_HINTS,
  nameFinder,
  noRecordHint,
  shownValue,
} from "@/lib/inbox/copy";
import {
  type CorrectionOutcome,
  type CorrectionSink,
  correctionFailureLine,
} from "@/lib/inbox/corrections";
import { canAddMatching, simulatedField } from "@/lib/inbox/demo";
import { editDiff } from "@/lib/inbox/edit";
import {
  adjacentCard,
  focusAfterBatch,
  focusAfterRemoval,
  followupStopId,
} from "@/lib/inbox/focus";
import {
  cardOrder,
  type InboxSections,
  inboxSections,
  isDecided,
  isSealed,
  isSnoozed,
} from "@/lib/inbox/groups";
import { type InputEventLike, inputOf } from "@/lib/inbox/input";
import type { InboxKeyAction } from "@/lib/inbox/keys";
import { decisionReview, reviewedState, snoozeOf, undoReview } from "@/lib/inbox/review";
import {
  type Change,
  type ChangeItem,
  type Failure,
  type LocalState,
  OptimisticReviews,
  type ReviewSink,
  singleChange,
  stateOf,
  withLocal,
} from "@/lib/inbox/sinks";
import { type SnoozeOption, snoozeUntil, whenWords } from "@/lib/inbox/time";
import type { InboxEntity, InboxProposal, InboxSession } from "@/lib/inbox/types";
import type { CardActions, CardDemo } from "./proposal-card";

export { followupStopId } from "@/lib/inbox/focus";

import { useInboxKeys } from "./use-inbox-keys";
import { BATCH_CLOCK_KEY, useReviewClock } from "./use-review-clock";
import { type RovingFocus, useRovingFocus } from "./use-roving-focus";
import { useShortcutsSetting } from "./use-shortcuts-setting";

/** One thing the reviewer did here, for u: the latest that still stands is undone first. */
type HistoryEntry =
  | {
      readonly kind: "review" | "snooze";
      readonly proposalId: string;
      /** The review's id, for a review. */
      readonly reviewId: string | null;
    }
  | { readonly kind: "batch"; readonly batchId: string };

/** An undo a toast offers, for a card. */
type UndoAction = (proposalId: string, event: InputEventLike) => void;

/**
 * The undos a toast can offer, read when its button is pressed: by then the page has re-rendered
 * with the optimistic change, and an undo made from the render that announced it would still see
 * the card as it was before (Phase 5 WP5's fix, the same here for the batch).
 */
interface ToastActions {
  readonly reopen: UndoAction;
  readonly wake: UndoAction;
  readonly undoBatch: (batchId: string, event: InputEventLike) => void;
}

/**
 * A card's correction panel, past the candidates (Phase 5 WP13): the field picker, the text box,
 * and the microphone on the capture screen while it's live. Absent where corrections can't be
 * written (the pilot), where the panel keeps only the candidates.
 */
export interface CorrectionBinding {
  /** What can be corrected: the record, then the type's fields. */
  readonly fields: readonly { readonly value: string; readonly label: string }[];
  readonly field: string;
  readonly text: string;
  readonly busy: boolean;
  /** Why the last try didn't go through: "I couldn't read a date in …". */
  readonly error: string | null;
  /** Whether the microphone is listening for this card's correction. */
  readonly listening: boolean;
  /** Whether a spoken correction can be made here now. */
  readonly canSpeak: boolean;
  readonly onField: (field: string) => void;
  readonly onText: (text: string) => void;
  readonly onSubmit: (event: InputEventLike) => void;
  readonly onSpeak: () => void;
}

/** A follow-up question's card, after its proposal's (Phase 5 WP13): c answers it, r skips it. */
export interface FollowupBinding {
  /** Its stop in the roving focus: `followup:` and the question's id. */
  readonly id: string;
  readonly question: FollowupView;
  /** The proposal it asks about: "Task · Pier Logistics". */
  readonly about: string;
  readonly active: boolean;
  readonly shortcuts: boolean;
  readonly answering: boolean;
  readonly text: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly listening: boolean;
  readonly canSpeak: boolean;
  readonly answer: (event: InputEventLike) => void;
  readonly skip: (event: InputEventLike) => void;
  readonly close: () => void;
  readonly onText: (text: string) => void;
  readonly onSubmit: (event: InputEventLike) => void;
  readonly onSpeak: () => void;
  readonly focused: () => void;
  /** Registers the question's card with the roving focus (not the review clock: it's no card). */
  readonly cardRef: (element: HTMLElement | null) => void;
}

/** What a card's component needs from the list, but its heading level. */
export interface CardBinding {
  readonly proposal: InboxProposal;
  readonly model: CardModel;
  readonly quotes: Readonly<Record<string, string>>;
  readonly active: boolean;
  readonly shortcuts: boolean;
  readonly editing: boolean;
  readonly correcting: boolean;
  readonly choice: number | null;
  readonly correctionChoice: number | null;
  readonly hint: string | null;
  readonly actions: CardActions;
  readonly menuFinalFocus: () => boolean;
  readonly cardRef: Ref<HTMLElement>;
  /** The card's demo controls in More (WP12), or absent where it gets none. */
  readonly demo?: CardDemo;
  /** The correction panel's field picker and text box (WP13), where corrections can be written. */
  readonly correction?: CorrectionBinding;
}

/**
 * The inbox's demo controls (Phase 5 WP12): which the page offers, and what each does. The card
 * gets one only where its record is a demo record (`simulatedField`, `canAddMatching`).
 */
export interface DemoControls {
  /** Whether the workspace's mirror is the demo CRM: then a new-record card can add its record. */
  readonly demoCrm: boolean;
  /** "Simulate a CRM change" on a card: moves one field of its record in the demo CRM. */
  readonly simulate: (sessionId: string, proposalId: string) => void;
  /** "Add a matching record" on a new-record card: adds the record it heard to the demo CRM. */
  readonly addMatching: (sessionId: string, proposalId: string) => void;
}

/** "Accept all from this call": its plans, its open checkpoint, and what it does. */
export interface BatchControls {
  /** Each reviewable debrief's plan, by session id. */
  readonly plans: ReadonlyMap<string, BatchPlan>;
  /** The debrief whose checkpoint is open, if any. */
  readonly open: string | null;
  /** Opens a debrief's checkpoint, or closes it if it's open. */
  readonly toggle: (sessionId: string) => void;
  /** Closes the checkpoint without accepting anything. */
  readonly cancel: () => void;
  /** Accepts what the open checkpoint lists, as one batch. */
  readonly confirm: (event: InputEventLike) => void;
  /** Undoes a batch: every card it still stands on comes back. */
  readonly undo: (batchId: string, event: InputEventLike) => void;
}

export interface ReviewListOptions {
  /** The debriefs, as loaded (the inbox) or folded from the socket (the tray). */
  readonly sessions: readonly InboxSession[];
  readonly entities: Readonly<Record<string, InboxEntity>>;
  readonly quotes: Readonly<Record<string, string>>;
  /** Where the page's reviews go: the web route, or the session socket. */
  readonly sink: ReviewSink;
  /** Where the reviews happen, as each records it: the inbox, the tray, or /pilot (WP7). */
  readonly surface: Extract<ReviewSurface, "inbox" | "tray" | "pilot">;
  /** Which debriefs' cards can be reviewed now; sealed ones by default (the inbox's rule). */
  readonly reviewable?: (session: InboxSession) => boolean;
  /** The server's clock when the data was read: the first render's, so it matches the server's. */
  readonly loadedAt: string;
  /** The inbox's demo controls (WP12); the tray and the pilot pass none. */
  readonly demo?: DemoControls;
  /**
   * Where corrections and follow-up skips go (WP13): the route in the inbox, the socket in the
   * tray. The pilot passes none: its panel keeps only the candidates, and it shows no questions.
   */
  readonly corrections?: CorrectionSink;
  /**
   * After a correction lands, so its card arrives: the inbox reads again the page holding the
   * debrief (`sessionId`), wherever "Load older" put it. The tray needs none: the session's events
   * bring it.
   */
  readonly onCorrected?: (sessionId: string) => Promise<void> | void;
}

export interface ReviewList {
  /** Whether this device has the single-key shortcuts on (Settings → Review). */
  readonly shortcuts: boolean;
  /** The debriefs with the page's own changes over them. */
  readonly sessions: readonly InboxSession[];
  readonly sections: InboxSections;
  /** Each group's cards in the order they're shown. */
  readonly order: readonly (readonly string[])[];
  readonly models: ReadonlyMap<string, CardModel>;
  /** The clock the sections were read at: the page's own, a minute at a time. */
  readonly now: number;
  /** Reads the page's clock now (after a reload, so snoozes that woke come back). */
  readonly refreshNow: () => void;
  /** How many changes are still on their way. */
  readonly sending: number;
  readonly store: OptimisticReviews;
  readonly roving: RovingFocus;
  /** Everything a card's component takes but its heading level, or null for a card not shown. */
  readonly card: (proposalId: string) => CardBinding | null;
  /** The open follow-up questions' cards after a proposal's card (WP13), in the order asked. */
  readonly followups: (proposalId: string) => readonly FollowupBinding[];
  /** The list's key handler, for the element holding its cards and "All caught up". */
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  /** Undo or Reopen: a reopen naming the card's latest review. */
  readonly reopen: UndoAction;
  /** A snoozed card back now. */
  readonly wake: UndoAction;
  readonly batch: BatchControls;
  readonly helpOpen: boolean;
  readonly setHelpOpen: (open: boolean) => void;
  /** Says something politely, replacing the last message: one per action (the demo controls). */
  readonly say: (text: string) => void;
  /** Says something urgently: a failure. */
  readonly warn: (text: string) => void;
}

/**
 * The review list's engine (Phase 5 spec WP5, WP6; ADR-0035), shared by the inbox, the capture
 * screen's tray, and the pilot page (WP7): the page's optimistic changes over the debriefs, the
 * sections and each card's
 * model, roving focus, the review clock, the single-key shortcuts, one message per action (an
 * urgent one per failure), the focus rules, undo with u, and "accept all" with its checkpoint.
 * The page renders; this decides, sends, and moves focus.
 */
export function useReviewList(options: ReviewListOptions): ReviewList {
  const { entities, quotes, surface } = options;
  const reviewable = options.reviewable ?? isSealed;
  const [shortcuts] = useShortcutsSetting();
  const [helpOpen, setHelpOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [choices, setChoices] = useState<Readonly<Record<string, number>>>({});
  const [corrections, setCorrections] = useState<Readonly<Record<string, number>>>({});
  const [hints, setHints] = useState<Readonly<Record<string, string>>>({});
  const [checkpoint, setCheckpoint] = useState<string | null>(null);
  // Corrections and follow-up questions (WP13), each keyed by its card's or question's stop.
  const sink = options.corrections;
  const [correctionFields, setCorrectionFields] = useState<Readonly<Record<string, string>>>({});
  const [correctionTexts, setCorrectionTexts] = useState<Readonly<Record<string, string>>>({});
  const [correctionErrors, setCorrectionErrors] = useState<Readonly<Record<string, string>>>({});
  const [correctionBusy, setCorrectionBusy] = useState<string | null>(null);
  const [listening, setListening] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [closedQuestions, setClosedQuestions] = useState<ReadonlySet<string>>(() => new Set());
  /** The proposal a correction just replaced: its replacement takes focus once it arrives. */
  const replacing = useRef<string | null>(null);
  // The server's clock until the page has its own, so the first render matches the server's.
  const [now, setNow] = useState(() => Date.parse(options.loadedAt));
  const [refreshNow] = useState(() => () => setNow(Date.now()));

  const onFailure = useRef<(failure: Failure) => void>(() => {});
  const toastActions = useRef<ToastActions | null>(null);
  const [store] = useState(
    () =>
      new OptimisticReviews(options.sink, {
        onFailure: (failure) => onFailure.current(failure),
      }),
  );
  const overlay = useSyncExternalStore(store.subscribe, store.overlay, store.overlay);
  const sending = useSyncExternalStore(store.subscribe, store.queued, store.queued);
  const pendingIds = useSyncExternalStore(store.subscribe, store.pendingIds, store.pendingIds);

  const sessions = useMemo<InboxSession[]>(
    () =>
      options.sessions.map((session) => ({
        ...session,
        proposals: session.proposals.map((proposal) => withLocal(proposal, overlay)),
      })),
    [options.sessions, overlay],
  );
  const sections = useMemo(
    () => inboxSections(sessions, entities, now, reviewable),
    [sessions, entities, now, reviewable],
  );
  /** The open questions a card shows after it: none where corrections can't be written. */
  const openQuestions = useMemo(() => {
    return (proposal: InboxProposal): FollowupView[] =>
      sink
        ? proposal.followups.filter(
            (question) => question.status === "open" && !closedQuestions.has(question.questionId),
          )
        : [];
  }, [sink, closedQuestions]);
  // Each group's stops: every card, each followed by its open questions' cards.
  const order = useMemo(
    () =>
      sections.review.map((group) =>
        group.accounts.flatMap((account) =>
          account.proposals.flatMap((proposal) => [
            proposal.proposalId,
            ...openQuestions(proposal).map((question) => followupStopId(question.questionId)),
          ]),
        ),
      ),
    [sections.review, openQuestions],
  );
  const found = useMemo(() => {
    const map = new Map<string, { proposal: InboxProposal; sessionId: string }>();
    for (const session of sessions) {
      for (const proposal of session.proposals) {
        map.set(proposal.proposalId, { proposal, sessionId: session.sessionId });
      }
    }
    return map;
  }, [sessions]);
  const models = useMemo(() => {
    const map = new Map<string, CardModel>();
    for (const id of order.flat()) {
      const entry = found.get(id);
      if (entry) map.set(id, cardModel(entry.proposal, entities, quotes, now));
    }
    return map;
  }, [order, found, entities, quotes, now]);
  // Recomputed as changes leave and land: a card with a change on its way waits out of a batch.
  const plans = useMemo(() => {
    const map = new Map<string, BatchPlan>();
    for (const group of sections.review) {
      const open = group.accounts.flatMap((account) => account.proposals);
      map.set(
        group.sessionId,
        batchPlan(group.sessionId, open, (id) => pendingIds.has(id), entities),
      );
    }
    return map;
  }, [sections.review, pendingIds, entities]);
  const nameOf = nameFinder(entities);

  const roving = useRovingFocus(order);
  // The cards' clocks pause while the checkpoint is open: its own clock times the batch.
  const { clock, batchClock, observe } = useReviewClock(
    checkpoint === null ? roving.activeId : null,
  );
  const history = useRef<HistoryEntry[]>([]);
  const { register } = roving;
  /** One ref callback per card, kept, so a re-render doesn't detach and re-observe it. */
  const [cardRef] = useState(() => {
    const refs = new Map<string, (element: HTMLElement | null) => void>();
    return (proposalId: string) => {
      let ref = refs.get(proposalId);
      if (!ref) {
        ref = (element: HTMLElement | null) => {
          register(proposalId, element);
          observe(proposalId, element);
        };
        refs.set(proposalId, ref);
      }
      return ref;
    };
  });
  /** One ref callback per question's card (WP13): the roving focus only. */
  const [questionRef] = useState(() => {
    const refs = new Map<string, (element: HTMLElement | null) => void>();
    return (stop: string) => {
      let ref = refs.get(stop);
      if (!ref) {
        ref = (element: HTMLElement | null) => register(stop, element);
        refs.set(stop, ref);
      }
      return ref;
    };
  });
  const lastToast = useRef<string | null>(null);
  /** Set while an action moves focus on, so a closing menu doesn't send it back to its trigger. */
  const focusMoved = useRef(false);

  // The page's own clock from here on, a minute at a time, for snoozes that wake.
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Reviews still on their way when the tab closes would be lost: the browser asks first.
  useEffect(() => {
    if (sending === 0) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [sending]);

  // ─── Messages ──────────────────────────────────────────────────────────────────────────────────

  /**
   * The action's one polite message, replacing the last, with Undo when it can be undone. The undo
   * is read from `toastActions` when the button is pressed, not from this render.
   */
  function announce(
    text: string,
    undo?: (actions: ToastActions, event: InputEventLike) => void,
  ): void {
    if (lastToast.current) toast.close(lastToast.current);
    let id = "";
    id = toast.add({
      title: text,
      priority: "low",
      ...(undo
        ? {
            actionProps: {
              children: "Undo",
              onClick: (event) => {
                toast.close(id);
                const actions = toastActions.current;
                if (actions) undo(actions, event);
              },
            },
          }
        : {}),
    });
    lastToast.current = id;
  }

  /** A failure: urgent, and longer on screen. */
  function warn(text: string): void {
    if (lastToast.current) toast.close(lastToast.current);
    lastToast.current = toast.add({
      title: text,
      type: "error",
      priority: "high",
      timeout: 10_000,
    });
  }

  const handleFailure = ({ change, reason, failed, landed }: Failure) => {
    const [review] = change.request.reviews;
    if (review?.mode === "batch") {
      const verb = review.decision === "reopened" ? "undo" : "accept";
      warn(batchFailureMessage(verb, change.items.length, landed.length, reason));
    } else {
      const [item] = change.items;
      const entry = item ? found.get(item.proposalId) : undefined;
      const what = entry ? cardWords(entry.proposal, nameOf) : "proposal";
      const [snooze] = change.request.snoozes;
      const verb = review
        ? review.decision === "reopened"
          ? "undo"
          : "review"
        : snooze?.until === null
          ? "wake"
          : "snooze";
      warn(failureMessage(verb, what, reason));
    }
    // A refusal that emptied the list left focus on "All caught up", which goes as the cards come
    // back: focus the first of them then, rather than let it fall to <body>.
    const first = failed[0];
    if (first) roving.rescue({ kind: "card", id: first.proposalId });
  };

  function hint(proposalId: string, text: string | null) {
    setHints((current) => {
      if ((current[proposalId] ?? null) === text) return current;
      const next = { ...current };
      if (text === null) delete next[proposalId];
      else next[proposalId] = text;
      return next;
    });
  }

  /** Clears a card's open panels, picks, and hint. */
  function settle(proposalId: string) {
    setEditing((current) => (current === proposalId ? null : current));
    setCorrecting((current) => (current === proposalId ? null : current));
    setChoices(({ [proposalId]: _, ...rest }) => rest);
    setCorrections(({ [proposalId]: _, ...rest }) => rest);
    hint(proposalId, null);
  }

  /** Focus moves on now, and the flag that keeps a closing menu from taking it back clears after. */
  function moveFocus(target: Parameters<RovingFocus["focus"]>[0]) {
    focusMoved.current = true;
    roving.focus(target);
    window.setTimeout(() => {
      focusMoved.current = false;
    }, 0);
  }

  /** A card's open questions' stops, which leave with it. */
  function questionStops(proposal: InboxProposal | undefined): Set<string> {
    return new Set(
      proposal
        ? openQuestions(proposal).map((question) => followupStopId(question.questionId))
        : [],
    );
  }

  /** A card leaves the list, its questions with it: focus moves on by the rules, before it's gone. */
  function leave(proposalId: string) {
    const stops = questionStops(found.get(proposalId)?.proposal);
    moveFocus(
      focusAfterRemoval(
        order.map((group) => group.filter((id) => !stops.has(id))),
        proposalId,
      ),
    );
    settle(proposalId);
  }

  function focusChooser(proposalId: string) {
    const card = document.querySelector<HTMLElement>(
      `[data-inbox-card][data-proposal-id="${CSS.escape(proposalId)}"]`,
    );
    const radio =
      card?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
      card?.querySelector<HTMLElement>('[role="radio"]');
    radio?.focus();
  }

  /** The state a review leaves its card in, keeping its snooze. */
  function after(proposal: InboxProposal, review: Parameters<typeof reviewedState>[0], at: Date) {
    return { ...reviewedState(review, at, UNDO_WINDOW_MS), snoozedUntil: proposal.snoozedUntil };
  }

  // ─── Decisions ─────────────────────────────────────────────────────────────────────────────────

  function decide(
    proposalId: string,
    how: {
      decision: "approved" | "edited" | "rejected";
      target?: { entityId: string | null } | null;
      editDiff?: Record<string, FieldEdit>;
      offered?: readonly (string | null)[];
      message: ActionMessage;
    },
    event: InputEventLike,
  ) {
    const entry = found.get(proposalId);
    if (entry?.proposal.status !== "proposed") return;
    const { proposal, sessionId } = entry;
    const timing = clock.commit(proposalId);
    const review = decisionReview({
      proposal,
      entities,
      decision: how.decision,
      target: how.target ?? null,
      ...(how.editDiff ? { editDiff: how.editDiff } : {}),
      ...(how.offered ? { offered: how.offered } : {}),
      timing,
      input: inputOf(event),
      surface,
    });
    const left = sections.openCount - 1;
    leave(proposalId);
    history.current.push({ kind: "review", proposalId, reviewId: review.reviewId });
    void store.apply(
      singleChange(
        sessionId,
        proposalId,
        { previous: stateOf(proposal), next: after(proposal, review, new Date()) },
        { reviews: [review], snoozes: [] },
      ),
    );
    announce(actionMessage(how.message, left, shortcuts), (actions, undoEvent) =>
      actions.reopen(proposalId, undoEvent),
    );
  }

  /** The record or value a numbered option stands for, decided now. */
  function choose(
    proposalId: string,
    options: readonly ChoiceOption[],
    index: number,
    event: InputEventLike,
  ) {
    const entry = found.get(proposalId);
    const option = options[index];
    if (!entry || !option) return;
    const { proposal } = entry;
    if (option.kind === "record") {
      const target = { entityId: option.entityId };
      decide(
        proposalId,
        {
          decision: "approved",
          target,
          offered: options.flatMap((candidate) =>
            candidate.kind === "record" ? [candidate.entityId] : [],
          ),
          message: {
            kind: "chose",
            choice: option.entityId === null ? "a new record" : nameOf(option.entityId),
            what: cardWords(proposal, nameOf, target),
          },
        },
        event,
      );
      return;
    }
    const field = proposal.fields[option.field];
    const choice =
      typeof option.value === "string" && option.label.startsWith("“")
        ? option.label
        : shownValue(option.field, option.value, field?.norm?.currency);
    const what = cardWords(proposal, nameOf);
    if (option.keep || !field) {
      decide(proposalId, { decision: "approved", message: { kind: "chose", choice, what } }, event);
    } else {
      decide(
        proposalId,
        {
          decision: "edited",
          editDiff: { [option.field]: { before: field.value, after: option.value } },
          message: { kind: "chose", choice, what },
        },
        event,
      );
    }
  }

  function accept(proposalId: string, event: InputEventLike) {
    const model = models.get(proposalId);
    const entry = found.get(proposalId);
    if (!model || !entry) return;
    clock.decide(proposalId);
    if (model.acceptable === "no_record") {
      hint(proposalId, noRecordHint(shortcuts));
      return;
    }
    const picked = choices[proposalId];
    if (model.chooser && picked !== undefined) {
      choose(proposalId, model.chooser.options, picked, event);
      return;
    }
    if (model.acceptable === "choose") {
      hint(proposalId, chooseHint(shortcuts));
      focusChooser(proposalId);
      return;
    }
    decide(
      proposalId,
      {
        decision: "approved",
        message: { kind: "accepted", what: cardWords(entry.proposal, nameOf) },
      },
      event,
    );
  }

  /**
   * "Keep the CRM's" on a 3-way card (WP12): an edit setting each field the CRM moved to its value
   * there now. When every such value is the one proposed, keeping the CRM's is keeping the rep's,
   * and the card is accepted.
   */
  function keepCrm(proposalId: string, event: InputEventLike) {
    const model = models.get(proposalId);
    const entry = found.get(proposalId);
    if (!model?.keepCrm || !entry) return;
    clock.decide(proposalId);
    const what = cardWords(entry.proposal, nameOf);
    if (Object.keys(model.keepCrm.editDiff).length === 0) {
      decide(proposalId, { decision: "approved", message: { kind: "accepted", what } }, event);
      return;
    }
    decide(
      proposalId,
      {
        decision: "edited",
        editDiff: { ...model.keepCrm.editDiff },
        message: { kind: "kept_crm", what, fields: model.keepCrm.words },
      },
      event,
    );
  }

  function reject(proposalId: string, event: InputEventLike) {
    const entry = found.get(proposalId);
    if (!entry) return;
    clock.decide(proposalId);
    decide(
      proposalId,
      {
        decision: "rejected",
        message: { kind: "rejected", what: cardWords(entry.proposal, nameOf) },
      },
      event,
    );
  }

  function edit(proposalId: string, _event: InputEventLike) {
    const model = models.get(proposalId);
    if (!model) return;
    clock.decide(proposalId);
    if (model.acceptable === "no_record") {
      hint(proposalId, noRecordHint(shortcuts));
      return;
    }
    if (model.acceptable === "choose" && choices[proposalId] === undefined) {
      hint(proposalId, chooseHint(shortcuts));
      focusChooser(proposalId);
      return;
    }
    hint(proposalId, null);
    setCorrecting(null);
    setEditing(proposalId);
  }

  function saveEdit(
    proposalId: string,
    values: Readonly<Record<string, FieldValue>>,
    event: InputEventLike,
  ) {
    const entry = found.get(proposalId);
    const model = models.get(proposalId);
    if (!entry || !model) return;
    const picked = choices[proposalId];
    const option =
      model.choosesRecord && picked !== undefined ? model.chooser?.options[picked] : undefined;
    const target = option?.kind === "record" ? { entityId: option.entityId } : null;
    const diff = editDiff(entry.proposal, values);
    decide(
      proposalId,
      {
        decision: "edited",
        target,
        editDiff: diff,
        message: { kind: "edited", what: cardWords(entry.proposal, nameOf, target) },
      },
      event,
    );
  }

  function cancelEdit(proposalId: string) {
    setEditing(null);
    roving.focus({ kind: "card", id: proposalId });
  }

  function correct(proposalId: string, _event: InputEventLike) {
    const model = models.get(proposalId);
    if (!model) return;
    clock.decide(proposalId);
    // A question's choices are its correction already, unless corrections can be written (WP13):
    // then the panel takes a typed record or a field too.
    if (model.choosesRecord && !sink) {
      focusChooser(proposalId);
      return;
    }
    setEditing(null);
    focusMoved.current = true;
    setCorrecting(proposalId);
    window.setTimeout(() => {
      focusMoved.current = false;
    }, 0);
  }

  function closeCorrection(proposalId: string) {
    setCorrecting(null);
    setCorrections(({ [proposalId]: _, ...rest }) => rest);
    roving.focus({ kind: "card", id: proposalId });
  }

  function useCorrection(proposalId: string, event: InputEventLike) {
    const model = models.get(proposalId);
    const picked = corrections[proposalId];
    if (!model || picked === undefined) return;
    choose(proposalId, model.correction, picked, event);
  }

  function snooze(proposalId: string, option: SnoozeOption, _event: InputEventLike) {
    const entry = found.get(proposalId);
    if (entry?.proposal.status !== "proposed") return;
    const { proposal, sessionId } = entry;
    clock.commit(proposalId);
    const at = new Date();
    const until = snoozeUntil(option, at);
    const request = snoozeOf(proposalId, until);
    const left = sections.openCount - 1;
    leave(proposalId);
    history.current.push({ kind: "snooze", proposalId, reviewId: null });
    void store.apply(
      singleChange(
        sessionId,
        proposalId,
        {
          previous: stateOf(proposal),
          next: { ...stateOf(proposal), snoozedUntil: request.until },
        },
        { reviews: [], snoozes: [request] },
      ),
    );
    announce(
      actionMessage(
        { kind: "snoozed", what: cardWords(proposal, nameOf), until: whenWords(until, at) },
        left,
        shortcuts,
      ),
      (actions, undoEvent) => actions.wake(proposalId, undoEvent),
    );
  }

  // ─── Corrections and follow-up questions (WP13) ────────────────────────────────────────────────

  /** What a card's panel can correct: its record, then its type's fields. */
  function correctableFields(proposal: InboxProposal) {
    return [
      { value: "target", label: "The record" },
      ...PROPOSAL_TYPE_FIELDS[proposal.type].map((field) => ({
        value: field,
        label: fieldLabel(field),
      })),
    ];
  }

  /** The record on a card about one; otherwise the type's first field. */
  function defaultField(proposal: InboxProposal): string {
    return proposal.target.decision === "none"
      ? (PROPOSAL_TYPE_FIELDS[proposal.type][0] ?? "target")
      : "target";
  }

  function setKeyed(set: typeof setCorrectionTexts, key: string, value: string | null): void {
    set((current) => {
      if ((current[key] ?? null) === value) return current;
      const next = { ...current };
      if (value === null) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  /**
   * After a correction: the panel or answer closes, one polite message says so, and the card
   * that replaced it takes the original's place and its focus once it arrives. A failure stays in
   * the panel, the words kept, its line an alert there (a form's error, not a toast).
   */
  async function settleCorrection(
    stop: string,
    proposal: InboxProposal,
    field: string,
    words: string | null,
    outcome: CorrectionOutcome,
    sessionId: string | null,
  ) {
    setCorrectionBusy(null);
    if (!outcome.ok) {
      const line = correctionFailureLine(outcome.code, { type: proposal.type, field, words });
      setKeyed(setCorrectionErrors, stop, line);
      return;
    }
    // Focus holds on the card until its replacement arrives and takes it (the effect below).
    replacing.current = proposal.proposalId;
    roving.focus({ kind: "card", id: proposal.proposalId });
    setCorrecting((current) => (current === proposal.proposalId ? null : current));
    setAnswering(null);
    setKeyed(setCorrectionTexts, stop, null);
    setKeyed(setCorrectionErrors, stop, null);
    announce(`Corrected: ${cardWords(proposal, nameOf)}. Its corrected card is back for review.`);
    if (sessionId !== null) await options.onCorrected?.(sessionId);
  }

  /** Sends typed words as a correction of `field`, maybe answering a question. */
  async function sendCorrection(
    stop: string,
    proposal: InboxProposal,
    sessionId: string,
    field: string,
    questionId: string | null,
  ) {
    const words = (correctionTexts[stop] ?? "").trim();
    if (!sink || words === "" || correctionBusy !== null) return;
    setCorrectionBusy(stop);
    setKeyed(setCorrectionErrors, stop, null);
    const outcome = await sink.correct({
      sessionId,
      proposalId: proposal.proposalId,
      field,
      questionId,
      text: words,
    });
    await settleCorrection(stop, proposal, field, words, outcome, sessionId);
  }

  /** The microphone: arms the next turn as the correction's words, or stops listening. */
  async function speak(
    stop: string,
    proposal: InboxProposal,
    field: string,
    questionId: string | null,
  ) {
    const speech = sink?.speech;
    if (!speech) return;
    if (listening === stop) {
      speech.finish();
      return;
    }
    if (listening !== null || correctionBusy !== null) return;
    setListening(stop);
    setKeyed(setCorrectionErrors, stop, null);
    const outcome = await speech.start({ proposalId: proposal.proposalId, field, questionId });
    setListening(null);
    // Spoken corrections are the tray's, whose session's events bring the corrected card.
    await settleCorrection(stop, proposal, field, null, outcome, null);
  }

  /** r on a question: it closes, and focus moves on as when a card leaves. */
  async function skipQuestion(stop: string, question: FollowupView, sessionId: string) {
    if (!sink || correctionBusy !== null) return;
    setCorrectionBusy(stop);
    const outcome = await sink.skip(sessionId, question.questionId);
    setCorrectionBusy(null);
    if (!outcome.ok) {
      warn(
        outcome.code === "stale"
          ? "That question was answered or skipped already. Reload to see it as it is."
          : "Earshot couldn't skip that question. Try again in a minute.",
      );
      return;
    }
    moveFocus(focusAfterRemoval(order, stop));
    setAnswering((current) => (current === question.questionId ? null : current));
    setClosedQuestions((current) => new Set([...current, question.questionId]));
    announce(`Skipped the question: ${question.text}`);
  }

  // The card a correction made takes the original's place (the groups keep its spot) and its focus,
  // once it arrives: from the inbox's next read, or the session's events in the tray.
  useEffect(() => {
    const replaced = replacing.current;
    if (replaced === null) return;
    for (const { proposal } of found.values()) {
      if (
        proposal.supersedes !== replaced ||
        !order.some((group) => group.includes(proposal.proposalId))
      ) {
        continue;
      }
      replacing.current = null;
      roving.focus({ kind: "card", id: proposal.proposalId });
      return;
    }
  });

  /** Each open question's stop: its question, the proposal it asks about, and the debrief. */
  const questions = useMemo(() => {
    const map = new Map<
      string,
      { question: FollowupView; proposal: InboxProposal; sessionId: string }
    >();
    for (const { proposal, sessionId } of found.values()) {
      for (const question of openQuestions(proposal)) {
        map.set(followupStopId(question.questionId), { question, proposal, sessionId });
      }
    }
    return map;
  }, [found, openQuestions]);

  function followupBinding(stop: string): FollowupBinding | null {
    const entry = questions.get(stop);
    const model = entry ? models.get(entry.proposal.proposalId) : undefined;
    if (!entry || !model || !sink) return null;
    const { question, proposal, sessionId } = entry;
    return {
      id: stop,
      question,
      about: `${model.type} · ${model.record}`,
      active: roving.activeId === stop,
      shortcuts,
      answering: answering === question.questionId,
      text: correctionTexts[stop] ?? "",
      busy: correctionBusy === stop,
      error: correctionErrors[stop] ?? null,
      listening: listening === stop,
      canSpeak: sink.speech !== undefined,
      answer: () => {
        focusMoved.current = true;
        setAnswering(question.questionId);
        window.setTimeout(() => {
          focusMoved.current = false;
        }, 0);
      },
      skip: () => void skipQuestion(stop, question, sessionId),
      close: () => {
        setAnswering(null);
        roving.focus({ kind: "card", id: stop });
      },
      onText: (text) => setKeyed(setCorrectionTexts, stop, text),
      onSubmit: () =>
        void sendCorrection(stop, proposal, sessionId, question.field, question.questionId),
      onSpeak: () => void speak(stop, proposal, question.field, question.questionId),
      focused: () => roving.arrived(stop),
      cardRef: questionRef(stop),
    };
  }

  function followups(proposalId: string): FollowupBinding[] {
    const entry = found.get(proposalId);
    if (!entry) return [];
    return openQuestions(entry.proposal).flatMap((question) => {
      const binding = followupBinding(followupStopId(question.questionId));
      return binding ? [binding] : [];
    });
  }

  // ─── "Accept all from this call" ───────────────────────────────────────────────────────────────

  function toggleCheckpoint(sessionId: string) {
    if (checkpoint === sessionId) {
      cancelCheckpoint();
      return;
    }
    // The batch's own time starts as its checkpoint opens (a fresh start for another debrief's).
    batchClock.commit(BATCH_CLOCK_KEY);
    batchClock.setVisible(BATCH_CLOCK_KEY, true);
    batchClock.setActive(BATCH_CLOCK_KEY);
    batchClock.input();
    setCheckpoint(sessionId);
  }

  function cancelCheckpoint() {
    batchClock.commit(BATCH_CLOCK_KEY);
    batchClock.setActive(null);
    setCheckpoint(null);
  }

  /** Accepts the open checkpoint's cards: one batch, one change, one message, one undo. */
  function confirmBatch(event: InputEventLike) {
    const sessionId = checkpoint;
    if (sessionId === null) return;
    const plan = plans.get(sessionId);
    if (!plan || plan.accept.length === 0) return;
    // Every item carries the batch's own time: from opening the checkpoint to this confirm.
    const timing = batchClock.commit(BATCH_CLOCK_KEY);
    batchClock.setActive(null);
    setCheckpoint(null);
    const { batchId, reviews } = batchReviews(plan.accept, {
      entities,
      timing,
      input: inputOf(event),
      surface,
    });
    const at = new Date();
    const items: ChangeItem[] = plan.accept.map((proposal, index) => {
      const review = reviews[index] as (typeof reviews)[number];
      return {
        proposalId: proposal.proposalId,
        previous: stateOf(proposal),
        next: after(proposal, review, at),
      };
    });
    const removed = new Set(items.map((item) => item.proposalId));
    const left = sections.openCount - removed.size;
    // The cards' questions leave with them.
    const gone = new Set(removed);
    for (const proposal of plan.accept) for (const stop of questionStops(proposal)) gone.add(stop);
    moveFocus(focusAfterBatch(order, gone));
    for (const proposalId of removed) {
      settle(proposalId);
      // A card the batch took starts again from zero if an undo brings it back.
      clock.commit(proposalId);
    }
    history.current.push({ kind: "batch", batchId });
    void store.apply({ sessionId, items, request: { reviews, snoozes: [] } });
    announce(batchMessage(removed.size, plan.stay.length, left, shortcuts), (actions, undoEvent) =>
      actions.undoBatch(batchId, undoEvent),
    );
  }

  /**
   * Undoes a batch, from u, its toast, or Reviewed: one reopen per card it still stands on, as one
   * change, and focus on the batch's first card once they're back.
   */
  function undoBatch(batchId: string, event: InputEventLike) {
    for (const session of sessions) {
      const items = batchItems(session.proposals, batchId);
      if (items.length === 0) continue;
      const reopens = batchUndoReviews(items, {
        batchId,
        entities,
        input: inputOf(event),
        surface,
      });
      const at = new Date();
      const changes: ChangeItem[] = items.map((proposal, index) => {
        const review = reopens[index] as (typeof reopens)[number];
        return {
          proposalId: proposal.proposalId,
          previous: stateOf(proposal),
          next: after(proposal, review, at),
        };
      });
      const change: Change = {
        sessionId: session.sessionId,
        items: changes,
        request: { reviews: reopens, snoozes: [] },
      };
      void store.apply(change);
      setNow(Date.now());
      // The batch's first card, as the list will show them once they're back.
      const back = new Map<string, LocalState>(changes.map((item) => [item.proposalId, item.next]));
      const restored = sessions.map((candidate) => ({
        ...candidate,
        proposals: candidate.proposals.map((proposal) => withLocal(proposal, back)),
      }));
      const nextOrder = cardOrder(inboxSections(restored, entities, now, reviewable).review);
      const first = nextOrder.flat().find((id) => back.has(id)) ?? items[0]?.proposalId;
      if (first) roving.focus({ kind: "card", id: first });
      announce(batchRestoredMessage(items.length, sections.openCount + items.length));
      return;
    }
  }

  // ─── Undo ──────────────────────────────────────────────────────────────────────────────────────

  /** Undo or Reopen: a reopen naming the latest review. The card comes back and takes focus. */
  function reopen(proposalId: string, event: InputEventLike) {
    const entry = found.get(proposalId);
    const latest = entry?.proposal.review;
    if (!entry || !latest || !isDecided(entry.proposal)) return;
    const { proposal, sessionId } = entry;
    const review = undoReview({
      proposal,
      entities,
      undoes: latest.reviewId,
      input: inputOf(event),
      surface,
    });
    void store.apply(
      singleChange(
        sessionId,
        proposalId,
        { previous: stateOf(proposal), next: after(proposal, review, new Date()) },
        { reviews: [review], snoozes: [] },
      ),
    );
    restored(proposal);
  }

  /** A snoozed card back now: a snooze with no time. */
  function wake(proposalId: string, _event: InputEventLike) {
    const entry = found.get(proposalId);
    if (!entry || !isSnoozed(entry.proposal, Date.now())) return;
    const { proposal, sessionId } = entry;
    const request = snoozeOf(proposalId, null);
    void store.apply(
      singleChange(
        sessionId,
        proposalId,
        { previous: stateOf(proposal), next: { ...stateOf(proposal), snoozedUntil: null } },
        { reviews: [], snoozes: [request] },
      ),
    );
    restored(proposal);
  }

  function restored(proposal: InboxProposal) {
    setNow(Date.now());
    roving.focus({ kind: "card", id: proposal.proposalId });
    announce(
      actionMessage(
        { kind: "restored", what: cardWords(proposal, nameOf) },
        sections.openCount + 1,
        shortcuts,
      ),
    );
  }

  /** u: the latest thing done here that still stands. */
  function undoLast(event: InputEventLike) {
    for (let entry = history.current.pop(); entry; entry = history.current.pop()) {
      if (entry.kind === "batch") {
        const { batchId } = entry;
        if (sessions.some((session) => batchItems(session.proposals, batchId).length > 0)) {
          undoBatch(batchId, event);
          return;
        }
        continue;
      }
      const current = found.get(entry.proposalId)?.proposal;
      if (!current) continue;
      if (
        entry.kind === "review" &&
        isDecided(current) &&
        current.review?.reviewId === entry.reviewId
      ) {
        reopen(entry.proposalId, event);
        return;
      }
      if (entry.kind === "snooze" && isSnoozed(current, Date.now())) {
        wake(entry.proposalId, event);
        return;
      }
    }
    announce(KEY_HINTS.nothingToUndo);
  }

  // The failure handler and the toasts' undos, as of the latest render.
  useEffect(() => {
    onFailure.current = handleFailure;
    toastActions.current = { reopen, wake, undoBatch };
  });

  // ─── Keys ──────────────────────────────────────────────────────────────────────────────────────

  function onAction(
    action: InboxKeyAction,
    cardId: string | null,
    event: KeyboardEvent<HTMLElement>,
  ) {
    switch (action.kind) {
      case "move": {
        const next = adjacentCard(order, cardId ?? null, action.step);
        if (next) roving.focus({ kind: "card", id: next });
        return true;
      }
      case "undo":
        undoLast(event);
        return true;
      case "help":
        setHelpOpen(true);
        return true;
      default:
        break;
    }
    if (cardId !== null && questions.has(cardId)) {
      // A question's card: c answers it, r skips it, and nothing else acts on it.
      const binding = followupBinding(cardId);
      if (!binding) return false;
      if (action.kind === "correct") binding.answer(event);
      else if (action.kind === "reject") binding.skip(event);
      else return false;
      return true;
    }
    if (cardId === null || !models.has(cardId)) return false;
    switch (action.kind) {
      case "accept":
        accept(cardId, event);
        return true;
      case "edit":
        edit(cardId, event);
        return true;
      case "reject":
        reject(cardId, event);
        return true;
      case "snooze":
        snooze(cardId, "tomorrow", event);
        return true;
      case "correct":
        correct(cardId, event);
        return true;
      case "choose": {
        const model = models.get(cardId);
        if (!model) return false;
        // The correction panel's records while it's open; otherwise the card's own choices. A
        // linked card has none, so a stray digit never changes its record.
        const options = correcting === cardId ? model.correction : (model.chooser?.options ?? []);
        // A 3-way card with no choices of its own (WP12): 1 keeps the rep's value, 2 the CRM's.
        if (options.length === 0 && correcting !== cardId && model.keepCrm) {
          if (action.index === 0) accept(cardId, event);
          else if (action.index === 1) keepCrm(cardId, event);
          else return false;
          return true;
        }
        if (action.index >= options.length) return false;
        clock.decide(cardId);
        choose(cardId, options, action.index, event);
        return true;
      }
    }
  }

  const onKeyDown = useInboxKeys({ enabled: shortcuts, onAction });

  const actions: CardActions = {
    accept,
    keepCrm,
    reject,
    edit,
    snooze,
    correct,
    select: (proposalId, index, from) => {
      clock.input();
      if (from === "chooser") setChoices((current) => ({ ...current, [proposalId]: index }));
      else setCorrections((current) => ({ ...current, [proposalId]: index }));
      hint(proposalId, null);
    },
    useCorrection,
    saveEdit,
    cancelEdit,
    closeCorrection,
    focused: roving.arrived,
  };

  const menuFinalFocus = () => !focusMoved.current;

  /** The card's demo controls (WP12): only where its record is a demo record. */
  function demoOf(proposal: InboxProposal, sessionId: string): CardDemo | undefined {
    const { demo } = options;
    if (!demo) return undefined;
    const { proposalId } = proposal;
    const simulate = simulatedField(proposal, entities) !== null;
    const addMatching = canAddMatching(proposal, demo.demoCrm);
    if (!simulate && !addMatching) return undefined;
    return {
      ...(simulate ? { simulate: () => demo.simulate(sessionId, proposalId) } : {}),
      ...(addMatching ? { addMatching: () => demo.addMatching(sessionId, proposalId) } : {}),
    };
  }

  function card(proposalId: string): CardBinding | null {
    const entry = found.get(proposalId);
    const model = models.get(proposalId);
    if (!entry || !model) return null;
    const demo = demoOf(entry.proposal, entry.sessionId);
    const { proposal, sessionId } = entry;
    const field = correctionFields[proposalId] ?? defaultField(proposal);
    const correction: CorrectionBinding | undefined = sink
      ? {
          fields: correctableFields(proposal),
          field,
          text: correctionTexts[proposalId] ?? "",
          busy: correctionBusy === proposalId,
          error: correctionErrors[proposalId] ?? null,
          listening: listening === proposalId,
          canSpeak: sink.speech !== undefined,
          onField: (value) => {
            clock.input();
            setKeyed(setCorrectionFields, proposalId, value);
            setKeyed(setCorrectionErrors, proposalId, null);
          },
          onText: (text) => {
            clock.input();
            setKeyed(setCorrectionTexts, proposalId, text);
          },
          onSubmit: () => void sendCorrection(proposalId, proposal, sessionId, field, null),
          onSpeak: () => void speak(proposalId, proposal, field, null),
        }
      : undefined;
    return {
      proposal: entry.proposal,
      model,
      quotes,
      active: roving.activeId === proposalId,
      shortcuts,
      editing: editing === proposalId,
      correcting: correcting === proposalId,
      choice: choices[proposalId] ?? null,
      correctionChoice: corrections[proposalId] ?? null,
      hint: hints[proposalId] ?? null,
      actions,
      menuFinalFocus,
      cardRef: cardRef(proposalId),
      ...(demo ? { demo } : {}),
      ...(correction ? { correction } : {}),
    };
  }

  return {
    shortcuts,
    sessions,
    sections,
    order,
    models,
    now,
    refreshNow,
    sending,
    store,
    roving,
    card,
    followups,
    onKeyDown,
    reopen,
    wake,
    batch: {
      plans,
      open: checkpoint,
      toggle: toggleCheckpoint,
      cancel: cancelCheckpoint,
      confirm: confirmBatch,
      undo: undoBatch,
    },
    helpOpen,
    setHelpOpen,
    say: (text) => announce(text),
    warn,
  };
}
