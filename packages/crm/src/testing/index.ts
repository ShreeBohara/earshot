// @earshot/crm/testing (Phase 6 WP2; docs/adr/0041): the reference CRM, the conformance suite's
// harness types, seeded faults, and what tests build plans from. Worker-safe (no Node APIs and no
// Vitest), so the outbox's tests can run MemoryCrm in workerd too; no Worker's own code imports it.
export { type DemoRaw, demoHarness, demoMirrorValues, memoryDemoRaw } from "./demo-harness";
export { type DemoChangeRow, MemoryDemoStore } from "./demo-store";
export { type FaultPlan, type FaultPoint, faultSchedule, seeded } from "./faults";
export type {
  ConformanceHarness,
  Fixture,
  FixtureEdit,
  HarnessAnswer,
  Made,
  MirrorValues,
  RawRecord,
} from "./harness";
export {
  MEMORY_CRM_API,
  MEMORY_MARKER_PROPERTY,
  MEMORY_OWNER,
  MEMORY_STAGES,
  MemoryCrm,
  type MemoryCrmOptions,
  type MemoryInjection,
  memoryCapabilities,
  memoryColumn,
  memoryCrmAdapter,
  memorySpecs,
} from "./memory-crm";
export {
  mirrorRef,
  PROPOSED_AT,
  planInput,
  proposalView,
  reviewView,
  type TargetSpec,
  testUuid,
} from "./proposals";
