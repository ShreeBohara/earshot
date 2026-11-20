// The simulator's homophone list (spec WP3 step 1): spellings a listener can't tell apart, the
// first of each set the commonest. The list moved to @earshot/understanding/names in Phase 4 WP4,
// unchanged, so linker v1 reads the same list as a candidate source; the simulator and the set's
// ground truth keep importing it from here. "Sean" (SN) and "Shawn" (XN) are why it exists: the
// eval knows they sound alike even where Double Metaphone says otherwise.
//
// A change to the list changes the confusable-name set's labels, so it needs a new set version
// (ADR-0028); the test that regenerates confusable.v1 fails on any byte of difference.
export {
  areHomophones,
  commonSpelling,
  HOMOPHONES,
  homophoneSet,
} from "@earshot/understanding/names";
