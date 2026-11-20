// @earshot/evals/channel: the mishearing simulator (Phase 4 spec, WP3 step 1). Seeded, pure, and
// shared by the confusable-name set (src/linking) and, from WP10, the generated debriefs.
export { areHomophones, commonSpelling, HOMOPHONES, homophoneSet } from "./homophones";
export { MISHEAR_OPS, type MishearOp, opCandidates } from "./ops";
export {
  type BiasedParams,
  CHANNEL_PARAMS,
  CHANNEL_VERSION,
  type ChannelParams,
  type WitnessParams,
} from "./params";
export { createRng, mulberry32, type Rng, subSeed } from "./rng";
export {
  type AlignOptions,
  alignPhrase,
  type Likeness,
  NEAR_DISTANCE,
  type PhraseMatch,
  type SoundWord,
  sameSoundPhrase,
  soundWords,
  wordLikeness,
  wordsLikeness,
} from "./sound";
export {
  type Heard,
  type HearOptions,
  hearBiased,
  hearUnbiased,
  keytermList,
  mishear,
  type NearSnap,
  snapToKeyterms,
} from "./witness";
