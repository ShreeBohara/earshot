// `@earshot/voice/session`: the client session runtime (spec WP8). `SessionClient` speaks the
// session socket protocol to SessionDO and folds its events into a `SessionStore` the screen
// subscribes to; the store also takes a recorded log, for `/demo`'s replay.
export {
  createSessionClient,
  type MessageAck,
  MessageRefusedError,
  type SendStartInput,
  type SendTurnEndInput,
  type SendUsageInput,
  SessionClient,
  type SessionClientOptions,
  SessionClosedError,
  type SessionLog,
} from "./client";
export { connectEngine, type EngineBridgeOptions } from "./engine-bridge";
export {
  browserPageLifecycle,
  isIosPlatform,
  type PageEvent,
  type PageLifecycle,
  STEADY_PAGE,
} from "./lifecycle";
export type { OutboxItem, OutboxMessage } from "./outbox";
export { defaultClassify, RetryDeadlineError, type WithRetryOptions, withRetry } from "./retry";
export {
  addUsage,
  type ClientIssueCode,
  type ConnectionView,
  EMPTY_METER,
  type FoldResult,
  type FoldStatus,
  type FoldStep,
  foldEvent,
  foldTurns,
  initialSessionState,
  MAX_ISSUES,
  type MeterView,
  reduceSessionState,
  type SessionIssue,
  type SessionProjections,
  type SessionState,
  SessionStore,
  type SessionStoreAction,
  type SessionStoreOptions,
  type TurnView,
  type WorkingView,
} from "./store";
export {
  createTicketFetcher,
  type SessionTicket,
  SessionTicketError,
  type TicketFetcherOptions,
  type TicketRouteFailure,
} from "./ticket";
