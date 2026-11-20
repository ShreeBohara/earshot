// Fixtures for tests and evals. Never imported by product code: the edge Worker's bundle must not
// carry them.

/** A pair of names as Postgres scored them. */
export interface MeasuredPair {
  readonly left: string;
  readonly right: string;
  /** `similarity(left, right)`, to 3 decimals. */
  readonly similarity: number;
  /** `word_similarity(left, right)`, to 3 decimals. */
  readonly wordSimilarity: number;
  /**
   * Postgres's `dmetaphone` (and `dmetaphone_alt`, after a slash, where the notes list it) of each
   * side: 4 characters at most, where `double-metaphone`'s codes run to full length.
   */
  readonly dmetaphone: readonly [left: string, right: string];
}

/**
 * The pairs measured on PGlite 0.5.16 (PostgreSQL 18.6) with `pg_trgm` and `fuzzystrmatch`, from
 * the Phase 4 build spec's Appendix A and the tooling check's §2. The trigram scores show why
 * candidates need sound as well as spelling: "Nite" and "Knight" share no trigram but sound the
 * same, and "Akme" and "Peer" fall under pg_trgm's 0.3 threshold.
 */
export const MEASURED_PAIRS: readonly MeasuredPair[] = [
  {
    left: "Atmas",
    right: "Atmos",
    similarity: 0.333,
    wordSimilarity: 0.5,
    dmetaphone: ["ATMS", "ATMS"],
  },
  {
    left: "Atmas",
    right: "Atlas",
    similarity: 0.333,
    wordSimilarity: 0.333,
    dmetaphone: ["ATMS", "ATLS"],
  },
  {
    left: "Atmas Group",
    right: "Atmos Industrial",
    similarity: 0.115,
    wordSimilarity: 0.25,
    dmetaphone: ["ATMS", "ATMS"],
  },
  {
    left: "Akme",
    right: "Acme",
    similarity: 0.25,
    wordSimilarity: 0.25,
    dmetaphone: ["AKM", "AKM"],
  },
  {
    left: "Akme Dynamics",
    right: "Acme Dynamics",
    similarity: 0.647,
    wordSimilarity: 0.714,
    dmetaphone: ["AKMT", "AKMT"],
  },
  {
    left: "Glovex",
    right: "Globelex",
    similarity: 0.333,
    wordSimilarity: 0.429,
    dmetaphone: ["KLFK", "KLPL"],
  },
  { left: "Nite", right: "Knight", similarity: 0, wordSimilarity: 0, dmetaphone: ["NT", "NT"] },
  {
    left: "Peer",
    right: "Pier",
    similarity: 0.25,
    wordSimilarity: 0.25,
    dmetaphone: ["PR", "P/PR"],
  },
  {
    left: "Rite Fabrication",
    right: "Wright Fabrication",
    similarity: 0.5,
    wordSimilarity: 0.706,
    dmetaphone: ["RTFP", "RTFP"],
  },
  {
    left: "Marshal Medical",
    right: "Marsh Medical",
    similarity: 0.8,
    wordSimilarity: 0.8,
    dmetaphone: ["MRXL", "MRXM"],
  },
  {
    left: "Kestral",
    right: "Kestrel",
    similarity: 0.455,
    wordSimilarity: 0.625,
    dmetaphone: ["KSTR", "KSTR"],
  },
  {
    left: "Sygma",
    right: "Sigma",
    similarity: 0.333,
    wordSimilarity: 0.333,
    dmetaphone: ["SKM", "SKM"],
  },
  {
    left: "Dana Li",
    right: "Dana Lee",
    similarity: 0.545,
    wordSimilarity: 0.75,
    dmetaphone: ["TNL", "TNL"],
  },
  {
    left: "Donna Lee",
    right: "Dana Lee",
    similarity: 0.462,
    wordSimilarity: 0.5,
    dmetaphone: ["TNL", "TNL"],
  },
  {
    left: "Catherine Moore",
    right: "Kathryn Moore",
    similarity: 0.304,
    wordSimilarity: 0.375,
    dmetaphone: ["K0RN/KTRN", "K0RN/KTRN"],
  },
  {
    left: "Northwind",
    right: "Northwind Logistics",
    similarity: 0.5,
    wordSimilarity: 1,
    dmetaphone: ["NR0N", "NR0N"],
  },
  {
    left: "MSC",
    right: "Meridian Supply Co",
    similarity: 0.045,
    wordSimilarity: 0.25,
    dmetaphone: ["MSK", "MRTN"],
  },
];
