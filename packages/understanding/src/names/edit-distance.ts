// Levenshtein distance, meant for Double Metaphone code strings ("ATMS" against "ATLS") but
// correct on any text: it counts code points, so a letter outside the Basic Multilingual Plane is
// one edit, not two. Hot in alignment and linking, so it allocates one row and nothing else for
// text without surrogate pairs, which is all codes and nearly all names.

const SURROGATE = /[\ud800-\udfff]/;

/** The text indexable by code point: the string itself, unless it has surrogate pairs. */
function codePoints(text: string): ArrayLike<string> {
  return SURROGATE.test(text) ? Array.from(text) : text;
}

function levenshtein(a: ArrayLike<string>, b: ArrayLike<string>): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // One row of the dynamic-programming table, updated in place.
  const row = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) row[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] ?? 0;
      const substitution = diagonal + (a[i - 1] === b[j - 1] ? 0 : 1);
      row[j] = Math.min(substitution, above + 1, (row[j - 1] ?? 0) + 1);
      diagonal = above;
    }
  }
  return row[b.length] ?? 0;
}

/** The fewest single-character insertions, deletions, and substitutions that turn `a` into `b`. */
export function editDistance(a: string, b: string): number {
  return a === b ? 0 : levenshtein(codePoints(a), codePoints(b));
}

/**
 * `editDistance` divided by the longer length, in [0, 1]: 0 for equal strings (two empty strings
 * included), 1 when nothing lines up.
 */
export function normalizedEditDistance(a: string, b: string): number {
  if (a === b) return 0;
  const left = codePoints(a);
  const right = codePoints(b);
  return levenshtein(left, right) / Math.max(left.length, right.length);
}
