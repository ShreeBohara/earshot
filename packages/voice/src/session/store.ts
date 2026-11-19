// The client's session store: every event SessionDO sends, upcast and validated by the
// `@earshot/events` registry, then folded with the same projections the server and Postgres use
// (`defaultProjections`), so the live screen, a replay, and the database agree. A few client-only
// projections ride along: the cost meter, the turns, and the ephemeral `working` state.
//
// Pure folds feed a small subscribable store: `subscribe` and `getState` fit React's
// `useSyncExternalStore`, and the state only ever changes identity when something changed. The
// store never holds a key: nothing that reaches it carries one (core's protocol refuses a
// key-shaped string in any server message), and the outbox keeps turn keys to itself.
import type {
  ServerMessageOf,
  SessionErrorCode,
  TurnMeasuredV1,
  TurnOutcome,
  UsageRecordedV1,
} from "@earshot/core";
import {
  defaultProjections,
  defaultRegistry,
  type EventRegistry,
  type ProjectionStates,
  parseEnvelope,
  type SessionEvent,
  UnknownEventError,
} from "@earshot/events";
import type { ConnectionCloseReason, ConnectionState } from "../machines/connection";

/** The server's projections, exactly as `replay(events, defaultProjections)` builds them. */
export type SessionProjections = ProjectionStates<typeof defaultProjections>;

/** Running cost totals, summed as SessionDO's meter sums them, to the nano-dollar. */
export interface MeterView {
  readonly costUsd: number;
  readonly stt: { readonly costUsd: number; readonly audioMs: number; readonly socketMs: number };
  readonly llm: {
    readonly costUsd: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
  };
  readonly speechToSpeech: { readonly costUsd: number };
  /** How many `usage.recorded` events the totals cover. */
  readonly records: number;
}

/** One turn, from its `turn.completed` and `turn.measured` events, whichever came. */
export interface TurnView {
  readonly turnId: string;
  readonly completed: {
    readonly outcome: TurnOutcome;
    readonly utteranceIds: readonly string[];
    readonly proposalIds: readonly string[];
    readonly attempts: number;
    readonly llmMs: number;
    readonly seq: number;
    readonly ts: string;
  } | null;
  readonly measured: (Omit<TurnMeasuredV1, "turnId"> & { readonly seq: number }) | null;
}

/** A turn SessionDO is working on (its ephemeral `working` message), until it completes. */
export interface WorkingView {
  readonly state: "thinking" | "retrying";
  readonly retryInMs: number | null;
  /** When it arrived, on the client's clock. */
  readonly at: number;
}

/**
 * Whether events still fold. `outdated`: the server sent an event type or version this client
 * doesn't know (reload to see the rest). `invalid`: an event broke its schema or a projection, or
 * the server's log disagreed with the one folded here. Either way folding stops, so the screen
 * never shows a log that differs from the server's, while the outbox keeps delivering.
 */
export type FoldStatus = "live" | "outdated" | "invalid";

/** Problems the client hit, for the screen. Codes only: never a message body or a key. */
export type ClientIssueCode =
  | "bad_message"
  | "bad_server_message"
  | "bad_event"
  | "unknown_event"
  | "foreign_event"
  | "desynced"
  | "missing_key";

export interface SessionIssue {
  readonly source: "server" | "client";
  readonly code: SessionErrorCode | ClientIssueCode;
  readonly retryable: boolean;
  /** The client message it concerns, when there is one. */
  readonly msgId?: string;
  /** When it happened, on the client's clock. */
  readonly at: number;
}

/** What the screen needs to know about the session socket. */
export interface ConnectionView {
  readonly state: ConnectionState;
  /** Failed connects in a row. */
  readonly attempt: number;
  readonly online: boolean;
  readonly reason: ConnectionCloseReason | null;
  readonly lastCode: number | null;
  /** In `backoff`: when the next attempt starts, on the client's clock. */
  readonly retryAt: number | null;
}

export interface SessionState {
  readonly sessionId: string;
  /** The last seq folded, or -1. `hello` resumes from it. */
  readonly lastSeq: number;
  readonly fold: FoldStatus;
  readonly projections: SessionProjections;
  readonly meter: MeterView;
  readonly turns: readonly TurnView[];
  /** The folded log at the latest schema versions, in seq order (index = seq). */
  readonly events: readonly SessionEvent[];
  /** When each folded event arrived, on the client's clock (index = seq), for latency marks. */
  readonly receivedAt: readonly number[];
  readonly working: Readonly<Record<string, WorkingView>>;
  readonly connection: ConnectionView;
  /** Client messages not yet acknowledged. */
  readonly pending: number;
  /** The latest problems, oldest first; at most `MAX_ISSUES`. */
  readonly issues: readonly SessionIssue[];
}

export const MAX_ISSUES = 20;

const roundUsd = (usd: number) => Math.round(usd * 1e9) / 1e9;

export const EMPTY_METER: MeterView = Object.freeze({
  costUsd: 0,
  stt: Object.freeze({ costUsd: 0, audioMs: 0, socketMs: 0 }),
  llm: Object.freeze({ costUsd: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }),
  speechToSpeech: Object.freeze({ costUsd: 0 }),
  records: 0,
});

/** The meter after one more usage record: the same arithmetic as SessionDO's `addUsage`. */
export function addUsage(meter: MeterView, usage: UsageRecordedV1): MeterView {
  const cost = usage.costUsd;
  return {
    costUsd: roundUsd(meter.costUsd + cost),
    stt:
      usage.kind === "stt"
        ? {
            costUsd: roundUsd(meter.stt.costUsd + cost),
            audioMs: meter.stt.audioMs + (usage.audioMs ?? 0),
            socketMs: meter.stt.socketMs + (usage.socketMs ?? 0),
          }
        : meter.stt,
    llm:
      usage.kind === "llm"
        ? {
            costUsd: roundUsd(meter.llm.costUsd + cost),
            inputTokens: meter.llm.inputTokens + (usage.inputTokens ?? 0),
            outputTokens: meter.llm.outputTokens + (usage.outputTokens ?? 0),
            cachedInputTokens: meter.llm.cachedInputTokens + (usage.cachedInputTokens ?? 0),
          }
        : meter.llm,
    speechToSpeech:
      usage.kind === "speech_to_speech"
        ? { costUsd: roundUsd(meter.speechToSpeech.costUsd + cost) }
        : meter.speechToSpeech,
    records: meter.records + 1,
  };
}

/** The turns after one event. */
export function foldTurns(turns: readonly TurnView[], event: SessionEvent): readonly TurnView[] {
  if (event.type !== "turn.completed" && event.type !== "turn.measured") return turns;
  const { turnId } = event.payload;
  const index = turns.findIndex((turn) => turn.turnId === turnId);
  const current: TurnView = turns[index] ?? { turnId, completed: null, measured: null };
  let next: TurnView;
  if (event.type === "turn.completed") {
    const { outcome, utteranceIds, proposalIds, attempts, llmMs } = event.payload;
    next = {
      ...current,
      completed: {
        outcome,
        utteranceIds,
        proposalIds,
        attempts,
        llmMs,
        seq: event.seq,
        ts: event.ts,
      },
    };
  } else {
    const { turnId: _, ...measured } = event.payload;
    next = { ...current, measured: { ...measured, seq: event.seq } };
  }
  return index === -1 ? [...turns, next] : turns.with(index, next);
}

export const initialConnectionView: ConnectionView = {
  state: "idle",
  attempt: 0,
  online: true,
  reason: null,
  lastCode: null,
  retryAt: null,
};

/** An empty store state for one session. */
export function initialSessionState(sessionId: string): SessionState {
  const projections = Object.fromEntries(
    Object.entries(defaultProjections).map(([name, projection]) => [name, projection.initial]),
  ) as SessionProjections;
  return {
    sessionId,
    lastSeq: -1,
    fold: "live",
    projections,
    meter: EMPTY_METER,
    turns: [],
    events: [],
    receivedAt: [],
    working: {},
    connection: initialConnectionView,
    pending: 0,
    issues: [],
  };
}

/** What folding one event did. */
export type FoldResult =
  | { readonly kind: "applied"; readonly event: SessionEvent }
  /** Already folded (a resume replays from the last seq the server knew was acked). */
  | { readonly kind: "duplicate" }
  /** It skipped ahead: the client must resume from `expectedSeq - 1`. */
  | { readonly kind: "gap"; readonly expectedSeq: number }
  /** Another session's event. Never folded. */
  | { readonly kind: "foreign" }
  /** Folding had already stopped. */
  | { readonly kind: "ignored" }
  /** Folding stops here: see `FoldStatus`. */
  | { readonly kind: "outdated" }
  | { readonly kind: "invalid" };

export interface FoldStep {
  readonly state: SessionState;
  readonly result: FoldResult;
}

function withIssue(state: SessionState, issue: SessionIssue): SessionState {
  return { ...state, issues: [...state.issues, issue].slice(-MAX_ISSUES) };
}

function stop(
  state: SessionState,
  fold: Exclude<FoldStatus, "live">,
  code: ClientIssueCode,
  at: number,
): FoldStep {
  return {
    state: withIssue({ ...state, fold }, { source: "client", code, retryable: false, at }),
    result: { kind: fold },
  };
}

/**
 * Folds one event from the server into the state, as `replay()` would fold it: envelope checked,
 * upcast to the latest version and validated, cloned, then applied to every default projection
 * in seq order. Pure: the same events always build the same state.
 */
export function foldEvent(
  state: SessionState,
  input: unknown,
  receivedAt: number,
  registry: EventRegistry<SessionEvent> = defaultRegistry,
): FoldStep {
  if (state.fold !== "live") return { state, result: { kind: "ignored" } };

  let envelope: ReturnType<typeof parseEnvelope>;
  try {
    envelope = parseEnvelope(input);
  } catch {
    return stop(state, "invalid", "bad_event", receivedAt);
  }
  if (envelope.sessionId !== state.sessionId) {
    return {
      state: withIssue(state, {
        source: "client",
        code: "foreign_event",
        retryable: false,
        at: receivedAt,
      }),
      result: { kind: "foreign" },
    };
  }
  if (envelope.seq <= state.lastSeq) {
    // The same seq must be the same event, or the two logs have parted.
    return state.events[envelope.seq]?.id === envelope.id
      ? { state, result: { kind: "duplicate" } }
      : stop(state, "invalid", "desynced", receivedAt);
  }
  if (envelope.seq > state.lastSeq + 1) {
    return { state, result: { kind: "gap", expectedSeq: state.lastSeq + 1 } };
  }

  let event: SessionEvent;
  try {
    if (registry.latestVersion(envelope.type) === undefined) {
      return stop(state, "outdated", "unknown_event", receivedAt);
    }
    // Cloned, as replay() clones it, so the state shares nothing with the message.
    event = structuredClone(registry.toLatest(envelope));
  } catch (error) {
    if (error instanceof UnknownEventError) {
      return stop(state, "outdated", "unknown_event", receivedAt); // a newer version
    }
    return stop(state, "invalid", "bad_event", receivedAt);
  }

  let projections: SessionProjections;
  try {
    projections = Object.fromEntries(
      Object.entries(defaultProjections).map(([name, projection]) => [
        name,
        (projection.apply as (state: unknown, event: SessionEvent) => unknown)(
          state.projections[name as keyof SessionProjections],
          event,
        ),
      ]),
    ) as SessionProjections;
  } catch {
    // A ProjectionError (a review of an unknown proposal, say): the log itself is broken.
    return stop(state, "invalid", "bad_event", receivedAt);
  }

  let working = state.working;
  if (event.type === "turn.completed" && event.payload.turnId in working) {
    const { [event.payload.turnId]: _, ...rest } = working;
    working = rest;
  }
  return {
    state: {
      ...state,
      lastSeq: event.seq,
      projections,
      meter: event.type === "usage.recorded" ? addUsage(state.meter, event.payload) : state.meter,
      turns: foldTurns(state.turns, event),
      events: [...state.events, event],
      receivedAt: [...state.receivedAt, receivedAt],
      working,
    },
    result: { kind: "applied", event },
  };
}

/** Changes to the store that don't come from events. SessionClient makes them. */
export type SessionStoreAction =
  | { readonly type: "working"; readonly message: ServerMessageOf<"working">; readonly at: number }
  | { readonly type: "issue"; readonly issue: SessionIssue }
  | { readonly type: "connection"; readonly connection: ConnectionView }
  | { readonly type: "pending"; readonly pending: number };

export function reduceSessionState(state: SessionState, action: SessionStoreAction): SessionState {
  switch (action.type) {
    case "working": {
      const { turnId, state: working, retryInMs } = action.message;
      // A turn already completed stays completed, whatever arrives late.
      if (state.turns.some((turn) => turn.turnId === turnId && turn.completed)) return state;
      return {
        ...state,
        working: {
          ...state.working,
          [turnId]: { state: working, retryInMs: retryInMs ?? null, at: action.at },
        },
      };
    }
    case "issue":
      return withIssue(state, action.issue);
    case "connection":
      return sameConnection(state.connection, action.connection)
        ? state
        : { ...state, connection: action.connection };
    case "pending":
      return state.pending === action.pending ? state : { ...state, pending: action.pending };
  }
}

function sameConnection(a: ConnectionView, b: ConnectionView): boolean {
  return (
    a.state === b.state &&
    a.attempt === b.attempt &&
    a.online === b.online &&
    a.reason === b.reason &&
    a.lastCode === b.lastCode &&
    a.retryAt === b.retryAt
  );
}

export interface SessionStoreOptions {
  readonly registry?: EventRegistry<SessionEvent>;
  /** The client's clock, for `receivedAt`. Defaults to `performance.now()`. */
  readonly now?: () => number;
}

/**
 * One session's store. Make a new one for every session: nothing in it may outlive its session
 * (v1 carried one call's tool calls into the next call's summary). SessionClient feeds it live;
 * `/demo`'s replay driver can feed it a recorded log the same way, through `applyEvent`.
 */
export class SessionStore {
  readonly sessionId: string;
  readonly #registry: EventRegistry<SessionEvent>;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  #state: SessionState;

  constructor(sessionId: string, options: SessionStoreOptions = {}) {
    this.sessionId = sessionId;
    this.#registry = options.registry ?? defaultRegistry;
    this.#now = options.now ?? (() => globalThis.performance.now());
    this.#state = initialSessionState(sessionId);
  }

  /** The current state. Stable between changes, so it can be `getSnapshot`. */
  readonly getState = (): SessionState => this.#state;

  /** Calls `listener` after every change. Returns the unsubscribe function. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Folds one event from the server (or a recorded log), in seq order. */
  applyEvent(event: unknown, receivedAt: number = this.#now()): FoldResult {
    const step = foldEvent(this.#state, event, receivedAt, this.#registry);
    this.#set(step.state);
    return step.result;
  }

  dispatch(action: SessionStoreAction): void {
    this.#set(reduceSessionState(this.#state, action));
  }

  #set(next: SessionState): void {
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A subscriber's bug mustn't stop the fold.
      }
    }
  }
}
