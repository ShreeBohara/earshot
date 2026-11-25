// @earshot/crm/testing (Phase 6 WP2; docs/adr/0041): the reference CRM and what tests build plans
// from. Worker-safe, so the outbox's tests can run it in workerd too; no Worker imports it.
export {
  mirrorRef,
  PROPOSED_AT,
  planInput,
  proposalView,
  reviewView,
  type TargetSpec,
  testUuid,
} from "./proposals";
