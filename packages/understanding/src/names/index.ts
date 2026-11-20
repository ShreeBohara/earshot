// The name toolkit (spec §5 WP2): pure string and sound functions shared by SessionDO's linker,
// the web app, the evals, and the CRM loader. Normalization is for matching only; a card shows
// the CRM's spelling.
export {
  type Alignment,
  type AlignmentStep,
  alignedRange,
  alignTokens,
  GAP_COST,
  MERGE_PENALTY,
  wordCost,
} from "./align";
export { editDistance, normalizedEditDistance } from "./edit-distance";
export { initials, isInitialsOf, joinSpelledLetters } from "./initials";
export { jaro, jaroWinkler } from "./jaro-winkler";
export { foldName, isLegalSuffix, LEGAL_SUFFIXES, nameTokens, normalizeName } from "./normalize";
export {
  type Codes,
  codeDistance,
  joinedCodes,
  nameCodes,
  phoneticDistance,
  phoneticKeys,
  sameSound,
  type TokenCodes,
  wordCodes,
} from "./phonetic";
export { similarity, trigramSimilarity, trigrams, wordSimilarity } from "./trigram";
