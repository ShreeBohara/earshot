// Shared planning (Phase 6 spec §4.3, §4.9; docs/adr/0041): §4.3's table as data each adapter
// fills in, and the pure helpers plans are made of: values as the approval left them, stage
// reading, owners, times in the rep's zone, the activity line, and names. All pure and synchronous.
export {
  ACTIVITY_LINE_PREFIX,
  activityLine,
  hasActivityLine,
  markerInBody,
  withActivityLine,
} from "./line";
export { defaultMapping, type MappedRep, ownerFor } from "./mapping";
export { splitName } from "./names";
export { readStage, STAGE_MARGIN, STAGE_SIMILARITY, type StageReading } from "./stages";
export {
  type ActivityObject,
  buildPlan,
  CHECKED_FIELDS,
  type CheckedField,
  type CompanyValues,
  type ContactValues,
  type DealValues,
  type Draft,
  type MeetingValues,
  type NoteValues,
  type PlanColumn,
  type RecordObject,
  type TaskValues,
} from "./table";
export {
  DUE_TIME,
  dueInstant,
  isCalendarDay,
  isClockTime,
  knownTimeZone,
  zonedInstant,
} from "./time";
export { approvedValues, seenValue, textOf } from "./values";
