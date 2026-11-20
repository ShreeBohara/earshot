// Evidence clips on the device (Phase 5 spec §4.7, WP9; ADR-0036): each turn's audio, encrypted in
// IndexedDB for 24 hours and never uploaded, and the player that replays a field's words from it.
export { type ClipAudioContext, ClipPlayer, type ClipPlayerOptions } from "./clip-player";
export {
  CLIP_SAMPLE_RATE,
  type ClipExtent,
  type ClipSpan,
  clipCovers,
  clipSample,
  clipSpan,
  EVIDENCE_PAD_MS,
  spanMiddle,
  spanSeconds,
} from "./clip-span";
export {
  CLIP_DB_NAME,
  CLIP_DB_VERSION,
  CLIP_TTL_MS,
  type Clip,
  type ClipBackend,
  type ClipInput,
  type ClipMeta,
  type ClipRecord,
  ClipStore,
  type ClipStoreOptions,
  clipAad,
  clipId,
  indexedDbClipBackend,
  memoryClipBackend,
  openClipRecord,
} from "./clip-store";
