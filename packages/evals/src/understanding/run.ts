// Runs a script through the understanding pipeline as SessionDO does, at $0 (Phase 4 WP10): each
// turn's request goes to the real LLM adapter, answered by the script's understanding cassette;
// `runTurn` drafts, links, normalizes, and checks; then the second witness (`heard.unbiased`) is
// compared with the turn's links (`witnessTurn`), and its flags and downgrades are applied as
// `proposalsProjection` folds `proposal.flagged`. Each turn sees the links the turns before it made.
import {
  createProposalExtractor,
  type LinkSession,
  runTurn,
  type ToolProposal,
  witnessTurn,
} from "@earshot/agent";
import { type Cassette, createCassetteFetch, SCENARIO_API_KEY } from "@earshot/agent/testing";
import type {
  LlmProvider,
  ProposalCreatedV2,
  ProposalFlaggedV1,
  UtteranceFinalV2,
} from "@earshot/core";
import { evalSession, evalTurnId } from "../generate";
import type { DebriefScript } from "../schema";
import { sessionContext } from "../session";
import { type ErrorLabels, understandingDrafts, understandingUtterances } from "./cassettes";

/** A proposal once the second witness has had its say. */
export type FinalProposal = ProposalCreatedV2;

export interface TurnRun {
  /** The drafts the cassette answered with: the model's words, quotes and all. */
  readonly drafts: readonly ToolProposal[];
  /** `proposal.created` v2, as written before the witness. */
  readonly biased: readonly ProposalCreatedV2[];
  /** The same proposals with the witness's flags and downgrades applied. */
  readonly final: readonly FinalProposal[];
  readonly flagged: readonly ProposalFlaggedV1[];
  readonly utterances: { readonly biased: UtteranceFinalV2; readonly unbiased: UtteranceFinalV2 };
  /** Requests the cassette couldn't answer: a stale cassette, or a script that changed. */
  readonly misses: number;
}

export interface ScriptRun {
  readonly script: DebriefScript;
  readonly provider: LlmProvider;
  readonly turns: readonly TurnRun[];
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

/** Runs one script on one provider's cassette. */
export async function runScript(
  provider: LlmProvider,
  script: DebriefScript,
  cassette: Cassette,
  labels: ErrorLabels,
): Promise<ScriptRun> {
  const fetch = createCassetteFetch(cassette);
  const extractor = createProposalExtractor({ provider, fetch: fetch as typeof globalThis.fetch });
  const context = sessionContext(script);
  let session: LinkSession = evalSession(script);
  let ids = 0;
  const turns: TurnRun[] = [];
  for (let index = 0; index < script.turns.length; index++) {
    const utterances = understandingUtterances(script, index);
    const missesBefore = fetch.misses.length;
    const result = await runTurn({
      extractor,
      turnId: evalTurnId(script, index),
      utterances: [utterances.biased],
      session,
      callTime: context.callTime,
      timeZone: context.timeZone,
      apiKey: SCENARIO_API_KEY,
      signal: new AbortController().signal,
      sleep: async () => {},
      newId: () => `01a1c6e8-0000-7000-8000-${(++ids).toString(16).padStart(12, "0")}`,
      random: () => 0.5,
    });
    const witness = witnessTurn({
      links: result.links,
      utterances: [utterances.biased],
      unbiased: utterances.unbiased,
      session,
    });
    turns.push({
      drafts: understandingDrafts(script, index, labels),
      biased: result.proposals,
      final: result.proposals.map((proposal) => applyFlagged(proposal, witness.flagged)),
      flagged: witness.flagged,
      utterances,
      misses: fetch.misses.length - missesBefore,
    });
    session = { ...session, recent: result.recent };
  }
  return { script, provider, turns };
}
