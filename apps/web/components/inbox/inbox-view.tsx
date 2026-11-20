"use client";

import { type FieldEdit, type FieldValue, UNDO_WINDOW_MS } from "@earshot/core";
import { Button } from "@earshot/ui/components/button";
import { toast } from "@earshot/ui/components/toast";
import { KeyboardIcon } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type CardModel, type ChoiceOption, cardModel } from "@/lib/inbox/card";
import {
  type ActionMessage,
  actionMessage,
  CAUGHT_UP_COPY,
  cardWords,
  failureMessage,
  KEY_HINTS,
  nameFinder,
  SECTION_TITLES,
  shownValue,
} from "@/lib/inbox/copy";
import { editDiff } from "@/lib/inbox/edit";
import { adjacentCard, focusAfterRemoval } from "@/lib/inbox/focus";
import { cardOrder, inboxSections, isDecided, isSnoozed } from "@/lib/inbox/groups";
import { type InputEventLike, inputOf } from "@/lib/inbox/input";
import type { InboxKeyAction } from "@/lib/inbox/keys";
import { decisionReview, reviewedState, snoozeOf, undoReview } from "@/lib/inbox/review";
import {
  type Failure,
  OptimisticReviews,
  type ReviewSink,
  routeSink,
  stateOf,
  withLocal,
} from "@/lib/inbox/sinks";
import { type SnoozeOption, snoozeUntil, whenWords } from "@/lib/inbox/time";
import type { InboxData, InboxProposal, InboxSession } from "@/lib/inbox/types";
import { CaptureLink } from "../capture/link";
import {
  accountName,
  FinishingSection,
  ReviewedSection,
  SnoozedSection,
  When,
} from "./inbox-sections";
import { type CardActions, ProposalCard } from "./proposal-card";
import { InboxShortcutsDialog } from "./shortcuts-dialog";
import { useInboxKeys } from "./use-inbox-keys";
import { useReviewClock } from "./use-review-clock";
import { useRovingFocus } from "./use-roving-focus";
import { useShortcutsSetting } from "./use-shortcuts-setting";

/** How often a finishing debrief is checked again (target). */
export const FINISHING_POLL_MS = 10_000;

/** `GET /api/inbox`: the first page again, or the page before `before`. Null on failure. */
export async function fetchInbox(before?: string): Promise<InboxData | null> {
  const query = before ? `?before=${encodeURIComponent(before)}` : "";
  try {
    const response = await fetch(`/api/inbox${query}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    return response.ok ? ((await response.json()) as InboxData) : null;
  } catch {
    return null;
  }
}

/** One thing the reviewer did here, for u: the latest that still stands is undone first. */
type HistoryEntry = {
  readonly kind: "review" | "snooze";
  readonly proposalId: string;
  /** The review's id, for a review. */
  readonly reviewId: string | null;
};

/** The first page read again, with any older pages this view loaded kept after it. */
function merged(current: InboxData, fresh: InboxData): InboxData {
  const ids = new Set(fresh.sessions.map((session) => session.sessionId));
  const older = current.sessions.filter(
    (session) =>
      !ids.has(session.sessionId) &&
      fresh.sessions.every((first) => first.startedAt >= session.startedAt),
  );
  return {
    sessions: [...fresh.sessions, ...older],
    entities: { ...current.entities, ...fresh.entities },
    quotes: { ...current.quotes, ...fresh.quotes },
    older: older.length > 0 ? current.older : fresh.older,
    loadedAt: fresh.loadedAt,
  };
}

export interface InboxViewProps {
  readonly initial: InboxData;
  /** Where reviews go: the web route, unless a story passes another. */
  readonly sink?: ReviewSink;
  /** Reads the inbox again: `GET /api/inbox`, unless a story passes another. */
  readonly reload?: (before?: string) => Promise<InboxData | null>;
}

/**
 * The review inbox (Phase 5 spec WP5; ADR-0035): the viewer's debriefs as groups of cards, each an
 * `<article>` in an `<ol>`, with roving focus, single-key shortcuts scoped to the list, one polite
 * message per action (an urgent one for a failure), the focus rules after a card leaves, the review
 * clock on every review, and Reviewed, Snoozed, and Finishing beside the cards.
 */
export function InboxView({ initial, sink, reload = fetchInbox }: InboxViewProps) {
  const [data, setData] = useState(initial);
  const [shortcuts] = useShortcutsSetting();
  const [helpOpen, setHelpOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [choices, setChoices] = useState<Readonly<Record<string, number>>>({});
  const [corrections, setCorrections] = useState<Readonly<Record<string, number>>>({});
  const [hints, setHints] = useState<Readonly<Record<string, string>>>({});
  // The server's clock until the page has its own, so the first render matches the server's.
  const [now, setNow] = useState(() => Date.parse(initial.loadedAt));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const headingId = useId();

  const onFailure = useRef<(failure: Failure) => void>(() => {});
  const [store] = useState(
    () =>
      new OptimisticReviews(sink ?? routeSink(), {
        onFailure: (failure) => onFailure.current(failure),
      }),
  );
  const overlay = useSyncExternalStore(store.subscribe, store.overlay, store.overlay);
  const sending = useSyncExternalStore(store.subscribe, store.queued, store.queued);

  const sessions = useMemo<InboxSession[]>(
    () =>
      data.sessions.map((session) => ({
        ...session,
        proposals: session.proposals.map((proposal) => withLocal(proposal, overlay)),
      })),
    [data.sessions, overlay],
  );
  const sections = useMemo(
    () => inboxSections(sessions, data.entities, now),
    [sessions, data.entities, now],
  );
  const order = useMemo(() => cardOrder(sections.review), [sections.review]);
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
      if (entry) map.set(id, cardModel(entry.proposal, data.entities, data.quotes));
    }
    return map;
  }, [order, found, data.entities, data.quotes]);
  const nameOf = nameFinder(data.entities);

  const roving = useRovingFocus(order);
  const { clock, observe } = useReviewClock(roving.activeId);
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

  // A finishing debrief: read the inbox again every 10 s while the page is visible, until it's
  // sealed and its cards arrive. Each read runs the repair path on the server.
  const finishing = sections.finishing.length > 0;
  useEffect(() => {
    if (!finishing) return;
    const timer = window.setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      const fresh = await reload();
      if (!fresh) return;
      setData((current) => merged(current, fresh));
      store.reconcile(fresh.sessions.flatMap((session) => session.proposals));
      setNow(Date.now());
    }, FINISHING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [finishing, reload, store]);

  // ─── Messages ──────────────────────────────────────────────────────────────────────────────────

  /** The action's one polite message, replacing the last, with Undo when it can be undone. */
  function announce(text: string, undo?: (event: InputEventLike) => void) {
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
                undo(event);
              },
            },
          }
        : {}),
    });
    lastToast.current = id;
  }

  /** A failure: urgent, and longer on screen. */
  function warn(text: string) {
    if (lastToast.current) toast.close(lastToast.current);
    lastToast.current = toast.add({
      title: text,
      type: "error",
      priority: "high",
      timeout: 10_000,
    });
  }

  const handleFailure = ({ change, reason }: Failure) => {
    const entry = found.get(change.proposalId);
    const what = entry ? cardWords(entry.proposal, nameOf) : "proposal";
    const [review] = change.request.reviews;
    const [snooze] = change.request.snoozes;
    const verb = review
      ? review.decision === "reopened"
        ? "undo"
        : "review"
      : snooze?.until === null
        ? "wake"
        : "snooze";
    warn(failureMessage(verb, what, reason));
  };
  useEffect(() => {
    onFailure.current = handleFailure;
  });

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

  /** A card leaves the list: focus moves on by the rules, before the card is gone. */
  function leave(proposalId: string) {
    focusMoved.current = true;
    roving.focus(focusAfterRemoval(order, proposalId));
    settle(proposalId);
    window.setTimeout(() => {
      focusMoved.current = false;
    }, 0);
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
      entities: data.entities,
      decision: how.decision,
      target: how.target ?? null,
      ...(how.editDiff ? { editDiff: how.editDiff } : {}),
      ...(how.offered ? { offered: how.offered } : {}),
      timing,
      input: inputOf(event),
    });
    const next = reviewedState(review, new Date(), UNDO_WINDOW_MS);
    const left = sections.openCount - 1;
    leave(proposalId);
    history.current.push({ kind: "review", proposalId, reviewId: review.reviewId });
    void store.apply({
      sessionId,
      proposalId,
      previous: stateOf(proposal),
      next: { ...next, snoozedUntil: proposal.snoozedUntil },
      request: { reviews: [review], snoozes: [] },
    });
    announce(actionMessage(how.message, left, shortcuts), (undoEvent) =>
      reopen(proposalId, undoEvent),
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
      hint(proposalId, KEY_HINTS.noRecord);
      return;
    }
    const picked = choices[proposalId];
    if (model.chooser && picked !== undefined) {
      choose(proposalId, model.chooser.options, picked, event);
      return;
    }
    if (model.acceptable === "choose") {
      hint(proposalId, KEY_HINTS.choose);
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
      hint(proposalId, KEY_HINTS.noRecord);
      return;
    }
    if (model.acceptable === "choose" && choices[proposalId] === undefined) {
      hint(proposalId, KEY_HINTS.choose);
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
    // A question's choices are its correction already.
    if (model.choosesRecord) {
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
    void store.apply({
      sessionId,
      proposalId,
      previous: stateOf(proposal),
      next: { ...stateOf(proposal), snoozedUntil: request.until },
      request: { reviews: [], snoozes: [request] },
    });
    announce(
      actionMessage(
        { kind: "snoozed", what: cardWords(proposal, nameOf), until: whenWords(until, at) },
        left,
        shortcuts,
      ),
      (undoEvent) => wake(proposalId, undoEvent),
    );
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
      entities: data.entities,
      undoes: latest.reviewId,
      input: inputOf(event),
    });
    const next = reviewedState(review, new Date(), UNDO_WINDOW_MS);
    void store.apply({
      sessionId,
      proposalId,
      previous: stateOf(proposal),
      next: { ...next, snoozedUntil: proposal.snoozedUntil },
      request: { reviews: [review], snoozes: [] },
    });
    restored(proposal);
  }

  /** A snoozed card back now: a snooze with no time. */
  function wake(proposalId: string, _event: InputEventLike) {
    const entry = found.get(proposalId);
    if (!entry || !isSnoozed(entry.proposal, Date.now())) return;
    const { proposal, sessionId } = entry;
    const request = snoozeOf(proposalId, null);
    void store.apply({
      sessionId,
      proposalId,
      previous: stateOf(proposal),
      next: { ...stateOf(proposal), snoozedUntil: null },
      request: { reviews: [], snoozes: [request] },
    });
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

  async function loadOlder() {
    if (!data.older || loadingOlder) return;
    setLoadingOlder(true);
    const page = await reload(data.older);
    setLoadingOlder(false);
    if (!page) return;
    setData((current) => {
      const ids = new Set(current.sessions.map((session) => session.sessionId));
      return {
        sessions: [...current.sessions, ...page.sessions.filter((s) => !ids.has(s.sessionId))],
        entities: { ...current.entities, ...page.entities },
        quotes: { ...current.quotes, ...page.quotes },
        older: page.older,
        loadedAt: current.loadedAt,
      };
    });
  }

  // ─── The page ──────────────────────────────────────────────────────────────────────────────────

  const empty = data.sessions.length === 0;
  const caughtUp = sections.review.length === 0;
  return (
    <div className="flex flex-col gap-10" data-inbox="" data-sending={sending}>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="font-serif text-4xl tracking-tight">Inbox</h1>
          <p className="max-w-prose text-pretty text-muted-foreground">
            {sections.openCount === 0
              ? "Nothing waits for your review."
              : `${sections.openCount} ${sections.openCount === 1 ? "proposal waits" : "proposals wait"} for your review. Nothing reaches your CRM until you accept it.`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setHelpOpen(true)}>
          <KeyboardIcon aria-hidden="true" data-icon="inline-start" />
          Keyboard shortcuts
        </Button>
      </header>

      <section aria-labelledby={headingId} className="flex flex-col gap-4">
        <h2 id={headingId} className="font-medium text-base">
          {SECTION_TITLES.review}
        </h2>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the list's single-key shortcuts, scoped to it (WCAG 2.1.4) */}
        <div className="flex flex-col gap-8" onKeyDown={onKeyDown} data-inbox-list="">
          {sections.review.map((group) => {
            const groupHeadingId = `${headingId}-group-${group.sessionId}`;
            return (
              <div key={group.sessionId} className="flex flex-col gap-3" data-slot="session-group">
                <h3 id={groupHeadingId} className="font-medium text-sm">
                  {accountName(data.entities, group.accountId)}{" "}
                  <span className="text-muted-foreground">
                    · <When iso={group.startedAt} now={now} />
                  </span>
                </h3>
                {group.accounts.map((account) => {
                  const accountHeadingId = `${groupHeadingId}-${account.accountId ?? "none"}`;
                  return (
                    <Fragment key={account.accountId ?? "none"}>
                      {group.byAccount ? (
                        <h4 id={accountHeadingId} className="text-muted-foreground text-xs">
                          {account.accountId
                            ? accountName(data.entities, account.accountId)
                            : "No account named"}
                        </h4>
                      ) : null}
                      <ol
                        aria-labelledby={
                          group.byAccount ? `${groupHeadingId} ${accountHeadingId}` : groupHeadingId
                        }
                        className="flex flex-col gap-3"
                      >
                        {account.proposals.map((proposal) => {
                          const model = models.get(proposal.proposalId);
                          if (!model) return null;
                          const id = proposal.proposalId;
                          return (
                            <li key={id}>
                              <ProposalCard
                                proposal={proposal}
                                model={model}
                                quotes={data.quotes}
                                headingLevel={group.byAccount ? 5 : 4}
                                active={roving.activeId === id}
                                shortcuts={shortcuts}
                                editing={editing === id}
                                correcting={correcting === id}
                                choice={choices[id] ?? null}
                                correctionChoice={corrections[id] ?? null}
                                hint={hints[id] ?? null}
                                actions={actions}
                                menuFinalFocus={() => !focusMoved.current}
                                cardRef={cardRef(id)}
                              />
                            </li>
                          );
                        })}
                      </ol>
                    </Fragment>
                  );
                })}
              </div>
            );
          })}
          {caughtUp ? (
            <div className="flex flex-col gap-1 rounded-xl border border-dashed p-6 text-center">
              <h3
                ref={roving.registerCaughtUp}
                tabIndex={-1}
                className="rounded-sm font-medium text-base outline-none focus-visible:focus-ring"
                data-slot="caught-up"
              >
                {empty ? CAUGHT_UP_COPY.empty : CAUGHT_UP_COPY.done}
              </h3>
              <p className="text-pretty text-muted-foreground text-sm">
                {empty ? (
                  <>
                    Debrief a call, or load the sample debriefs in{" "}
                    <CaptureLink
                      href="/settings/data"
                      className="rounded-sm text-foreground underline underline-offset-4 outline-none focus-visible:focus-ring"
                    >
                      Settings → Data
                    </CaptureLink>
                    , and their proposals appear here.
                  </>
                ) : (
                  CAUGHT_UP_COPY.doneDetail
                )}
              </p>
            </div>
          ) : null}
        </div>
      </section>

      <FinishingSection groups={sections.finishing} entities={data.entities} now={now} />
      <ReviewedSection
        items={sections.reviewed}
        entities={data.entities}
        undoWindowMs={UNDO_WINDOW_MS}
        onReopen={reopen}
      />
      <SnoozedSection items={sections.snoozed} entities={data.entities} now={now} onWake={wake} />

      {data.older ? (
        <div>
          <Button variant="outline" size="sm" disabled={loadingOlder} onClick={loadOlder}>
            {loadingOlder ? "Loading…" : "Load older debriefs"}
          </Button>
        </div>
      ) : null}

      <InboxShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} shortcuts={shortcuts} />
    </div>
  );
}
