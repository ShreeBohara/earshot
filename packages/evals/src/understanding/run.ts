// Runs a script through the understanding pipeline as SessionDO does (Phase 4 WP10): each turn's
// request goes to the real LLM adapter; `runTurn` drafts, links, normalizes, and checks; then the
// second witness (`heard.unbiased`) is compared with the turn's links (`witnessTurn`), and its
// flags and downgrades are applied as `proposalsProjection` folds `proposal.flagged`. Each turn
// sees the links the turns before it made.
//
// `runScript` answers each request from the script's understanding cassette, at $0. WP11's live
// smoke eval runs the same loop on a live model through `runScriptWith`, with its own extractor,
// so both are scored by the same metrics.
import {
  createProposalExtractor,
  type ExtractionFailure,
  type LinkSession,
  type ProposalExtractor,
  type RetryPolicy,
  runTurn,
  type ToolProposal,
  witnessTurn,
} from "@earshot/agent";
import { type Cassette, createCassetteFetch, SCENARIO_API_KEY } from "@earshot/agent/testing";
import type {
  LlmProvider,
  ProposalCreatedV2,
  ProposalFlaggedV1,
  TurnCompletedV1,
  TurnOutcome,
  UsageRecordedV1,
  UtteranceFinalV2,
} from "@earshot/core";
import { evalSession, evalTurnId } from "../generate";
import type { DebriefScript } from "../schema";
import { sessionContext } from "../session";
import { type ErrorLabels, understandingDrafts, understandingUtterances } from "./cassettes";

/** A proposal once the second witness has had its say. */
export type FinalProposal = ProposalCreatedV2;

/** A turn's two transcripts: the production stream's final and the second witness's. */
export interface TurnUtterances {
  readonly biased: UtteranceFinalV2;
  readonly unbiased: UtteranceFinalV2;
}

export interface TurnRun {
  /** The drafts the model answered with: its words, quotes and all. */
  readonly drafts: readonly ToolProposal[];
  /** `proposal.created` v2, as written before the witness. */
  readonly biased: readonly ProposalCreatedV2[];
  /** The same proposals with the witness's flags and downgrades applied. */
  readonly final: readonly FinalProposal[];
  readonly flagged: readonly ProposalFlaggedV1[];
  readonly utterances: TurnUtterances;
  /** Requests the cassette couldn't answer: a stale cassette, or a script that changed. */
  readonly misses: number;
  /** How the turn ended, as `turn.completed` records it. Every run sets it. */
  readonly outcome?: TurnOutcome;
  /** Why the extraction failed, as fixed codes; null when it didn't. Every run sets it. */
  readonly failure?: { readonly code: ExtractionFailure; readonly detail: string } | null;
  /**
   * `turn.completed` as SessionDO appends it, and the turn's `usage.recorded` (null when no call
   * reported tokens). Every run sets them; the pilot set's logs are built from them (Phase 5 WP7).
   */
  readonly completed?: TurnCompletedV1;
  readonly usage?: UsageRecordedV1 | null;
}

export interface ScriptRun {
  readonly script: DebriefScript;
  readonly provider: LlmProvider;
  readonly turns: readonly TurnRun[];
}

export interface RunOptions {
  /** What every turn's request goes through: a cassette's adapter at $0, a live model's in WP11. */
  readonly extractor: ProposalExtractor;
  /** Passed to the extractor on each turn, and to nothing else. */
  readonly apiKey: string;
  /** Each turn's two transcripts; `understandingUtterances`, with no word timings, by default. */
  readonly utterances?: (script: DebriefScript, turnIndex: number) => TurnUtterances;
  /** Each turn's drafts for the metrics; by default, the ones the extractor returned. */
  readonly drafts?: (turnIndex: number) => readonly ToolProposal[];
  /** Requests a cassette couldn't answer so far, if one is answering. */
  readonly misses?: () => number;
  /** Aborting it cancels the turn in flight and every one after it (the smoke budget's stop). */
  readonly signal?: AbortSignal;
  /** The turns' retries: `runTurn`'s default, the product's 8 s deadline, when absent. */
  readonly retry?: RetryPolicy;
  /** The wait before a retry: a real, abortable timer when absent. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Jitter for the retry backoff: `Math.random` when absent. */
  readonly random?: () => number;
  /** Called after each turn, before the next starts: where a caller stops the run early. */
  readonly onTurn?: (turn: TurnRun, turnIndex: number) => void;
}

/** A proposal with a `proposal.flagged` folded in, as `proposalsProjection` folds it. */
export function applyFlagged(
  proposal: ProposalCreatedV2,
  flagged: readonly ProposalFlaggedV1[],
): FinalProposal {
  let out = proposal;
  for (const flag of flagged) {
    if (flag.proposalId !== proposal.proposalId) continue;
    out = {
      ...out,
      riskFlags: [...out.riskFlags, ...flag.flags],
      target: flag.target
        ? {
            ...out.target,
            decision: "ask",
            entityId: null,
            candidates: flag.target.candidates.map((c) => ({ ...c })),
          }
        : out.target,
    };
  }
  return out;
}

/** Runs one script through `options.extractor`, turn by turn, as SessionDO would. */
export async function runScriptWith(
  script: DebriefScript,
  options: RunOptions,
): Promise<ScriptRun> {
  const inner = options.extractor;
  // The drafts each turn's extraction returned, for the metrics: the model's own quotes.
  let drafted: readonly ToolProposal[] = [];
  const extractor: ProposalExtractor = {
    ...inner,
    async extract(input) {
      const result = await inner.extract(input);
      drafted = result.drafts;
      return result;
    },
  };
  const context = sessionContext(script);
  const signal = options.signal ?? new AbortController().signal;
  const utterancesOf = options.utterances ?? understandingUtterances;
  let session: LinkSession = evalSession(script);
  let ids = 0;
  const turns: TurnRun[] = [];
  for (let index = 0; index < script.turns.length; index++) {
    const utterances = utterancesOf(script, index);
    const missesBefore = options.misses?.() ?? 0;
    drafted = [];
    const result = await runTurn({
      extractor,
      turnId: evalTurnId(script, index),
      utterances: [utterances.biased],
      session,
      callTime: context.callTime,
      timeZone: context.timeZone,
      apiKey: options.apiKey,
      signal,
      ...(options.retry ? { retry: options.retry } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.random ? { random: options.random } : {}),
      newId: () => `01a1c6e8-0000-7000-8000-${(++ids).toString(16).padStart(12, "0")}`,
    });
    const witness = witnessTurn({
      links: result.links,
      utterances: [utterances.biased],
      unbiased: utterances.unbiased,
      session,
    });
    const turn: TurnRun = {
      drafts: options.drafts?.(index) ?? drafted,
      biased: result.proposals,
      final: result.proposals.map((proposal) => applyFlagged(proposal, witness.flagged)),
      flagged: witness.flagged,
      utterances,
      misses: (options.misses?.() ?? 0) - missesBefore,
      outcome: result.completed.outcome,
      failure: result.failure,
      completed: result.completed,
      usage: result.usage,
    };
    turns.push(turn);
    options.onTurn?.(turn, index);
    session = { ...session, recent: result.recent };
  }
  return { script, provider: inner.provider, turns };
}

/**
 * Runs one script on one provider's understanding cassette, at $0. `now` is the extractor's clock
 * for its latency: the wall clock unless given, so the pilot set's builder passes a fixed one and
 * its logs come out the same byte for byte (Phase 5 WP7).
 */
export function runScript(
  provider: LlmProvider,
  script: DebriefScript,
  cassette: Cassette,
  labels: ErrorLabels,
  options: { readonly now?: () => number } = {},
): Promise<ScriptRun> {
  const fetch = createCassetteFetch(cassette);
  return runScriptWith(script, {
    extractor: createProposalExtractor({
      provider,
      fetch: fetch as typeof globalThis.fetch,
      ...(options.now ? { now: options.now } : {}),
    }),
    apiKey: SCENARIO_API_KEY,
    // The cassette's drafts are the ground truth with its seeded errors, by construction.
    drafts: (index) => understandingDrafts(script, index, labels),
    misses: () => fetch.misses.length,
    sleep: async () => {},
    random: () => 0.5,
  });
}
