// `@earshot/voice/session`: the client session runtime (spec WP8). `SessionClient` speaks the
// session socket protocol to SessionDO and folds its events into a `SessionStore` the screen
// subscribes to; the store also takes a recorded log, for `/demo`'s replay. `SessionWitness`
// runs the second witness on each turn's audio and sends its transcript (Phase 4 WP9).
export {
  type CorrectionDelivery,
  type CorrectionRoute,
  createSessionClient,
  type MessageAck,
  MessageRefusedError,
  type ReviewDelivery,
  type SendCorrectionInput,
  type SendStartInput,
  type SendTurnEndInput,
  type SendUsageInput,
  type SendWitnessInput,
  SessionClient,
  type SessionClientOptions,
  SessionClosedError,
  type SessionLog,
} from "./client";
export { type ArmedCorrection, connectEngine, type EngineBridgeOptions } from "./engine-bridge";
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
  createReviewRoute,
  type ReviewRoute,
  ReviewRouteFailure,
  type ReviewRouteOptions,
  type ReviewRouteRequestBody,
  reviewFrameBytes,
  splitReviews,
} from "./reviews";
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
export {
  fitWitnessUtterance,
  SessionWitness,
  type SessionWitnessOptions,
  TURN_AUDIO_WAIT_MS,
  WITNESS_WINDOW_MARGIN_MS,
  type WitnessSetup,
} from "./witness";
