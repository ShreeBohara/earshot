// @earshot/agent: turn extraction for SessionDO (Phase 3 spec, WP5). Runs in workerd and Node.
// Cassettes and test scenarios live in `@earshot/agent/testing`, which production code doesn't
// import.
export { type AttachContext, attachEvidence, type ProposalDraft } from "./attach";
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
  fieldRiskFlags,
  LOW_CONFIDENCE_THRESHOLD,
  NEGATION_LOOKBEHIND_WORDS,
} from "./risk";
export {
  DATE_FIELDS,
  MAX_FIELD_CHARS,
  MAX_PROPOSALS_PER_TURN,
  SUBMIT_PROPOSALS,
  SUBMIT_PROPOSALS_JSON_SCHEMA,
  type SubmitProposalsInput,
  submitProposalsInput,
  TARGET_KINDS,
  type ToolProposal,
} from "./schema";
export {
  type RunTurnInput,
  runTurn,
  sessionErrorFor,
  TURN_OUTCOMES,
  type TurnResult,
  type WorkingState,
} from "./turn";
export { addUsage, fromSdkUsage, type TokenUsage, ZERO_USAGE } from "./usage";
