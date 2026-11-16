# ADR-0025: LLM adapters on AI SDK 7: providers built per call, per-turn keys, one batch tool, evidence by quotation, AI Gateway optional

## Status

Accepted (2026-11-15)

## Context and problem

Phase 3's gate needs a proposal card within 2.5 s of the rep releasing push-to-talk. `SessionDO` turns each turn's final utterances into `proposal.created` events, on the user's own LLM key, which rides on that turn's `turn_end` message and is used for one call (Phase 3 spec, decision 2; ADR-0021). The extraction has to:

- run in workerd, inside `SessionDO`;
- support Claude Haiku 5.5, which has strict tool use, and Groq's gpt-oss-20b, which is cheaper and faster but has no strict tool arguments and can't call tools in parallel;
- give every field evidence (`proposal.created` v1 requires it): the utterance, a character span, an audio window, and a confidence;
- never keep, log, or return the key;
- cost $0 in CI.

## Considered options

- **AI SDK 7 (`ai` 7.0.x with `@ai-sdk/anthropic` and `@ai-sdk/groq` 4.0.x), with the provider built inside each call (chosen).**
- Each provider's REST API called with `fetch`, behind the same interface. Kept as the fallback if AI SDK 7 misbehaved in workerd (spec §8); the smoke test shows it doesn't.
- Cloudflare's `createAI` from `agents/models/ai-sdk`. It adds the `agents` package and an `AI` binding, and a key stored on the gateway wins over the per-request one.
- One tool per proposal type, as v1 had. On Groq that's one round trip per proposal.
- Asking the model for character offsets. Models count characters badly; quoting words is what they do well.

## Decision

`packages/agent` exports a `ProposalExtractor` per provider (`createProposalExtractor`) and `runTurn`, which `SessionDO` calls on `turn_end`.

- **Providers per call.** `extract()` builds `createAnthropic` or `createGroq` from the key it's given, with an explicit `baseURL` (so `ANTHROPIC_BASE_URL` in the environment can't redirect a key), and drops it when the call returns. Nothing at module scope or on the extractor holds a key.
- **One batch tool.** Each turn makes one forced call of `submit_proposals`, whose input is `{ proposals }`; each field is `{ value, quote }`. The JSON Schema meets Anthropic's strict rules (no length, range, pattern, or `oneOf` keywords) and Groq's (every property required, closed objects, optional fields as a `null` union). Anthropic gets `strict: true` and one tool call at most; Groq gets the lowest reasoning effort its SDK offers (`reasoningEffort: "low"`). Haiku 5.5 takes no temperature and skips thinking on a forced call, so neither is set.
- **Validation and one retry, for both adapters.** The input is checked with Zod: structure, then calendar dates, non-negative amounts, and length limits. A failure, a reply with no tool call (AI SDK 7 throws `ToolChoiceViolationError`), or Groq's own `400 tool_use_failed` gets one more call with the problems listed. A second failure is `invalid_output`. A refusal is not retried.
- **Evidence by quotation.** Each quote is found in the turn's utterances: exactly, then ignoring case and whitespace, then ignoring punctuation at the edges of words. With word timings, when every word of the text the span covers lines up with a recognized word, those words give the audio window and the lowest word confidence. When only some line up (the text says "$50k" where the provider heard "fifty thousand"), every recognized word between the nearest lined-up neighbors counts, and the confidence is capped at the utterance's, so a partial match can't raise it. With no word to attribute, the window is interpolated by character position and the confidence is the utterance's. A field whose quote isn't found is dropped and flagged `unsupported`; a proposal left with no fields is dropped.
- **Risk flags and targets.** Simple patterns flag dates, numbers, and negations, the last including a few words before the quote; evidence below 0.7 gets `low_confidence`. `targetEntityId` is an exact, case-insensitive name or alias match among the session's entities, of the kinds the proposal type allows; an ambiguous match is null. A contact with no match is `new_entity`.
- **Turns.** `runTurn` retries 429s, 5xx, and timeouts, honoring `Retry-After`, then backing off exponentially with jitter, at most 3 attempts inside an 8-second deadline. It returns the `proposal.created`, `usage.recorded`, and `turn.completed` payloads to append, the `error` to send, and a fixed failure code to log. Every failure is an `ExtractionError` with a fixed message; the provider's body, headers, and message are never copied.
- **Cost.** Each call is priced from a dated table: uncached input, cache reads, cache writes, and output (reasoning included), with Haiku's long-prompt card above 100k tokens.
- **AI Gateway, optional.** With `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_ID` set, `baseURL` points at `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/{groq | anthropic/v1}` and every request sends `cf-aig-collect-log: false`. The key still travels in the provider's own header.
- **Cassettes at the fetch level.** Providers take a `fetch`. A cassette `fetch` answers from interactions keyed by a SHA-256 of the method, the URL path, and the canonical body, and throws on anything else. `@earshot/agent/testing` ships hand-made cassettes for the demo session's seven turns and the failure cases; `scripts/gen-cassettes.ts` builds them by running the real adapters against hand-written provider responses, and a test fails if the committed files drift. Recording live calls needs `EARSHOT_RECORD_CASSETTES=1` plus a key, and refuses any interaction holding part of one.

## Consequences

**Good**

- The same code runs in Node and workerd. A workerd test runs both adapters with the edge Worker's compatibility date and flags; it also passes without `nodejs_compat`.
- A key can't outlive its turn or cross to another user: providers are local to a call.
- Evidence comes from code, not from the model's arithmetic, and a missing quote is visible as a dropped field and a flag.
- CI never calls a provider, and a change to the prompt or the schema shows up as regenerated cassette keys.

**Bad**

- The AI SDK adds about 1.8 MB (310 KB gzipped) to a Worker that imports it. Startup time is measured on the first deploy.
- Groq's invalid output costs a second round trip. Groq does have strict structured output (`response_format`), but not with tools.
- Quote matching is literal: a paraphrased quote loses its field. Phase 4's faithfulness check and normalizers replace this.
- Two pieces are local stand-ins: the price table belongs in `@earshot/voice/prices` (WP4) and the retry policy in WP8's shared `retry` machine. Both are single functions to swap.

## More information

- Phase 3 build spec, WP5; the cassettes live in `packages/agent/cassettes/`.
- Still to check with one live call each (spec Appendix B, question 16): AI Gateway's Anthropic path suffix. The live latency of both models is G1b's job.
