// @earshot/agent: turn extraction for SessionDO (Phase 3 spec, WP5), and from Phase 4 the turn
// pipeline (spec §4.3): extractor v2, then `understand` with the linker, the normalizers, and the
// faithfulness check, and from WP9 the second witness's comparison (`witnessTurn`). Runs in
// workerd and Node. Cassettes and test scenarios live in `@earshot/agent/testing`, which
// production code doesn't import.
export { matchEntity } from "./entities";
export {
  type CallFailure,
  classifyCallError,
  ExtractionError,
  type ExtractionErrorInit,
  type ExtractionFailure,
  retryAfterMs,
} from "./errors";
export { evidenceFor, locateQuote, type QuoteLocation, type QuoteMatch } from "./evidence";
export {
  createProposalExtractor,
  type ExtractInput,
  type ExtractorOptions,
  type ExtractResult,
  LLM_MODELS,
  type ProposalExtractor,
} from "./extractor";
export {
  AI_GATEWAY_HEADERS,
  AI_GATEWAY_PATHS,
  type AiGatewayConfig,
  aiGatewayFromEnv,
  DIRECT_BASE_URLS,
  providerEndpoint,
} from "./gateway";
export {
  findLlmPrice,
  LLM_PRICES,
  type LlmPriceRow,
  type LlmPriceTable,
  type LlmRates,
  llmCostUsd,
  roundUsd,
} from "./prices";
export { buildPrompt, describeCallTime, type Prompt, type PromptInput } from "./prompt";
export { DEFAULT_RETRY_POLICY, nextRetryDelay, type RetryInput, type RetryPolicy } from "./retry";
export {
  DATE_FIELDS,
  MAX_FIELD_CHARS,
  MAX_PROPOSALS_PER_TURN,
  MAX_TARGET_CHARS,
  SUBMIT_PROPOSALS,
  SUBMIT_PROPOSALS_DESCRIPTION,
  SUBMIT_PROPOSALS_JSON_SCHEMA,
  type SubmitProposalsInput,
  submitProposalsInput,
  TARGET_KINDS,
  TIME_FIELDS,
  type ToolField,
  type ToolProposal,
  type ToolTarget,
  toolTarget,
} from "./schema";
export {
  type RunTurnInput,
  runTurn,
  sessionErrorFor,
  TURN_OUTCOMES,
  type TurnResult,
  type WorkingState,
} from "./turn";
export {
  draftMention,
  type LinkDraft,
  type LinkSession,
  LOW_CONFIDENCE_THRESHOLD,
  linkerMention,
  MAX_RECENT_LINKS,
  type ProposalDraft,
  type TurnUnderstanding,
  type UnderstandContext,
  understand,
  understandTurn,
  withRecentLinks,
} from "./understand";
export { addUsage, fromSdkUsage, type TokenUsage, ZERO_USAGE } from "./usage";
export {
  type ProposalLink,
  type WitnessTurnInput,
  type WitnessTurnResult,
  witnessTurn,
} from "./witness";
