// Reading a deal stage from a rep's words (Phase 6 spec §4.9, decision 16): the words, normalized
// as the name toolkit normalizes names, match a stage's label or one of its words exactly, or by
// trigram similarity of 0.6 or more with one clear winner. Anything else is `unmapped`: the card's
// preview says so before approval, and a job that got through fails with it. No model call.
import type { CrmMappedStage } from "@earshot/core";
import { normalizeName, similarity } from "@earshot/understanding/names";

/** The least trigram similarity a near miss needs (target, §4.9). */
export const STAGE_SIMILARITY = 0.6;

/**
 * How far a near miss must lead the next one to be the clear winner (target, where the spec is
 * silent): two stages within this of each other are both plausible, and the reading refuses.
 */
export const STAGE_MARGIN = 0.1;

/** What `readStage` made of the words. */
export type StageReading =
  | {
      readonly ok: true;
      readonly stage: CrmMappedStage;
      /** `exact` for a label or word, `similar` for a near miss. */
      readonly how: "exact" | "similar";
      /** 1 for an exact match; the trigram similarity of a near miss. */
      readonly score: number;
    }
  | {
      readonly ok: false;
      /** `empty`: no words; `none`: nothing like them; `ambiguous`: two or more fit as well. */
      readonly reason: "empty" | "none" | "ambiguous";
      /** The stages that fit, best first, when the reading was ambiguous. */
      readonly candidates: readonly CrmMappedStage[];
    };

/** A stage's names: its label and its words, as the toolkit normalizes them, without blanks. */
function namesOf(stage: CrmMappedStage): string[] {
  return [stage.label, ...stage.words].map(normalizeName).filter((name) => name !== "");
}

/** A stage's identity: its id within its pipeline. */
function keyOf(stage: CrmMappedStage): string {
  return `${stage.pipelineId ?? ""}\u0000${stage.stageId}`;
}

/** The stages, each once, in the order given. */
function distinct(stages: readonly CrmMappedStage[]): CrmMappedStage[] {
  const seen = new Set<string>();
  return stages.filter((stage) => {
    const key = keyOf(stage);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The stage a rep's words name, among a mapping's stages. Narrowed first to `pipelineId`'s stages
 * when one is given (a new deal's pipeline). An exact match on a label or a word wins; two stages
 * that both match exactly are ambiguous. Otherwise the best near miss, at `STAGE_SIMILARITY` or
 * more, wins when no other is within `STAGE_MARGIN` of it.
 */
export function readStage(
  words: string,
  stages: readonly CrmMappedStage[],
  options: { readonly pipelineId?: string | null } = {},
): StageReading {
  const said = normalizeName(words);
  if (said === "") return { ok: false, reason: "empty", candidates: [] };
  const { pipelineId } = options;
  const pool =
    pipelineId === undefined || pipelineId === null
      ? stages
      : stages.filter((stage) => stage.pipelineId === pipelineId);

  const exact = distinct(pool.filter((stage) => namesOf(stage).includes(said)));
  const [only] = exact;
  if (only !== undefined && exact.length === 1) {
    return { ok: true, stage: only, how: "exact", score: 1 };
  }
  if (exact.length > 1) return { ok: false, reason: "ambiguous", candidates: exact };

  const scored = distinct(pool)
    .map((stage) => ({
      stage,
      score: Math.max(0, ...namesOf(stage).map((name) => similarity(said, name))),
    }))
    .filter((entry) => entry.score >= STAGE_SIMILARITY)
    .sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (best === undefined) return { ok: false, reason: "none", candidates: [] };
  if (next !== undefined && best.score - next.score < STAGE_MARGIN) {
    return {
      ok: false,
      reason: "ambiguous",
      candidates: scored
        .filter((entry) => best.score - entry.score < STAGE_MARGIN)
        .map((entry) => entry.stage),
    };
  }
  return { ok: true, stage: best.stage, how: "similar", score: best.score };
}
