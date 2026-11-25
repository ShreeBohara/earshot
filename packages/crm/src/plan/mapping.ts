// A connection's mapping, as plans read it (Phase 6 spec §4.9, decision 16): the rep's CRM owner,
// and a mapping made from a CRM's schema the way WP5 makes version 1 at connect (each stage's label
// is its own word; owners matched by the reps' emails; the defaults). Pure.
import {
  type CrmMapping,
  MAX_MAPPED_OWNERS,
  MAX_MAPPED_STAGES,
  MAX_STAGE_WORDS,
} from "@earshot/core";
import type { Capabilities, CrmSchema } from "../adapter";

/** The rep's CRM owner, by their Earshot user id, when the mapping names one (§4.9). */
export function ownerFor(
  mapping: Pick<CrmMapping, "owners">,
  userId: string | null,
): string | null {
  if (userId === null) return null;
  return mapping.owners.find((owner) => owner.userId === userId)?.ownerId ?? null;
}

/** A rep the mapping may name an owner for: their Earshot user id and email. */
export interface MappedRep {
  readonly userId: string;
  readonly email: string | null;
}

/**
 * A mapping made from a CRM's schema: every stage (up to `MAX_MAPPED_STAGES`) with its label, and
 * any `words` given for it by stage id; the first stage's pipeline for new deals; each rep whose
 * email a CRM owner has (case aside) mapped to that owner; and commitments as tasks and meetings
 * as meetings where the CRM holds them, notes otherwise.
 */
export function defaultMapping(
  schema: Pick<CrmSchema, "stages" | "owners">,
  capabilities: Pick<Capabilities, "objects">,
  options: {
    readonly reps?: readonly MappedRep[];
    readonly words?: Readonly<Record<string, readonly string[]>>;
  } = {},
): CrmMapping {
  const stages = schema.stages.slice(0, MAX_MAPPED_STAGES).map((stage) => ({
    stageId: stage.stageId,
    pipelineId: stage.pipelineId,
    label: stage.label,
    words: [...(options.words?.[stage.stageId] ?? [])].slice(0, MAX_STAGE_WORDS),
  }));
  const owners = (options.reps ?? []).flatMap((rep) => {
    const email = rep.email?.toLowerCase();
    const owner = email
      ? schema.owners.find((candidate) => candidate.email?.toLowerCase() === email)
      : undefined;
    return owner ? [{ userId: rep.userId, ownerId: owner.ownerId }] : [];
  });
  return {
    v: 1,
    stages,
    newDeals: { pipelineId: stages[0]?.pipelineId ?? null },
    owners: owners.slice(0, MAX_MAPPED_OWNERS),
    destinations: {
      commitment: capabilities.objects.task ? "task" : "note",
      meeting: capabilities.objects.meeting ? "meeting" : "note",
    },
  };
}
