// How a CRM connection's words map to its own ids (Phase 6 spec §4.9, decision 16; ADR-0040). One
// version per change, append-only (`crm_mappings`, migration 0020, WP5), made automatically from the
// CRM's schema when it's connected: each stage's label is its own word, owners are matched by the
// reps' emails, and the destinations take their defaults. Each sync job records the version it
// used, so a retry plans against the same mapping.
//
// `CrmMapping` is a contract: exported to JSON Schema and Pydantic, structural with no refinements,
// so both languages accept the same documents. Reading a stage from a rep's words (exact, then by
// trigram similarity with one clear winner) is the adapter SDK's (`@earshot/crm`, WP2).
import { z } from "zod";

/** The most stages a mapping holds, across every pipeline (target). */
export const MAX_MAPPED_STAGES = 100;
/** The most words one stage may be known by, its label aside (target). */
export const MAX_STAGE_WORDS = 10;
/** The most reps a mapping names a CRM owner for (target). */
export const MAX_MAPPED_OWNERS = 50;

/** A CRM id (a stage's, a pipeline's, an owner's): opaque, as the CRM spells it. */
const CrmId = z.string().min(1).max(128);

/**
 * One deal stage: its id in the CRM, the pipeline it belongs to (null where the CRM has none),
 * its label as the CRM shows it, and what a rep might say for it ("proposal", "sent the proposal").
 */
export const CrmMappedStage = z
  .strictObject({
    stageId: CrmId,
    pipelineId: CrmId.nullable(),
    label: z.string().min(1).max(120),
    words: z.array(z.string().min(1).max(60)).max(MAX_STAGE_WORDS),
  })
  .meta({ title: "CrmMappedStage" });
export type CrmMappedStage = z.infer<typeof CrmMappedStage>;

/** A rep, by Earshot user id, and the CRM owner their tasks are assigned to. */
export const CrmMappedOwner = z
  .strictObject({ userId: CrmId, ownerId: CrmId })
  .meta({ title: "CrmMappedOwner" });
export type CrmMappedOwner = z.infer<typeof CrmMappedOwner>;

/**
 * A version of a connection's mapping, version 1 of its form: the deal stages a rep's words map
 * to, the pipeline new deals go to (null for the CRM's default), each rep's CRM owner, and where
 * commitments and meetings land. `commitment` defaults to `task`, and `meeting` to `meeting` where
 * the CRM has meetings.
 */
export const CrmMapping = z
  .strictObject({
    v: z.literal(1),
    stages: z.array(CrmMappedStage).max(MAX_MAPPED_STAGES),
    newDeals: z.strictObject({ pipelineId: CrmId.nullable() }).meta({ title: "CrmNewDeals" }),
    owners: z.array(CrmMappedOwner).max(MAX_MAPPED_OWNERS),
    destinations: z
      .strictObject({
        commitment: z.enum(["task", "note"]),
        meeting: z.enum(["meeting", "note"]),
      })
      .meta({ title: "CrmDestinations" }),
  })
  .meta({
    title: "CrmMapping",
    description:
      "A version of a CRM connection's mapping, version 1 of its form: the deal stages a rep's words map to, the pipeline for new deals, each rep's CRM owner, and where commitments and meetings land.",
  });
export type CrmMapping = z.infer<typeof CrmMapping>;
