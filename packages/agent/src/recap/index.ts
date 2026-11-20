// @earshot/agent/recap (Phase 5 spec WP10; ADR-0037): the debrief's recap. One forced
// `submit_recap` call on the session's provider and key, after `session.ended`; the checks in code
// that keep only sentences with located quotes; methodology lenses as configuration; and priced
// usage. Runs in workerd and Node.
export {
  type CheckedRecap,
  checkRecap,
  lensMentioned,
  type SentenceFate,
  type SentenceTrace,
} from "./checks";
export {
  RECAP_LENS_LIST,
  RECAP_LENSES,
  type RecapLensDefinition,
  type RecapLensFieldDefinition,
  recapLens,
} from "./lenses";
export {
  buildRecapPrompt,
  type RecapPrompt,
  type RecapPromptInput,
  type RecapProposal,
  type RecapProposalSource,
  recapProposals,
  withRecapFeedback,
} from "./prompt";
export {
  createRecapper,
  failedRecap,
  RECAP_DEADLINE_MS,
  RECAP_MAX_OUTPUT_TOKENS,
  RECAP_RETRY_POLICY,
  type RecapCall,
  type RecapCallInput,
  type Recapper,
  type RecapperOptions,
  type RecapResult,
  type RunRecapInput,
  recapReason,
  recapUtterances,
  runRecap,
  skippedRecap,
} from "./run";
export {
  type RecapToolSentence,
  SUBMIT_RECAP,
  SUBMIT_RECAP_DESCRIPTION,
  SUBMIT_RECAP_JSON_SCHEMA,
  type SubmitRecapInput,
  submitRecapInput,
} from "./schema";
