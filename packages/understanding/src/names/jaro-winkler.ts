// Jaro-Winkler similarity, for the linker's `jw` feature on normalized names. Winkler's standard
// settings: a common prefix of up to 4 characters, a scaling factor of 0.1, and the prefix bonus
// only above a Jaro score of 0.7. Counts code points.

const PREFIX_SCALE = 0.1;
const MAX_PREFIX = 4;
const BOOST_THRESHOLD = 0.7;

/**
 * Jaro similarity in [0, 1]: matching characters (equal, and no further apart than half the longer
 * length, less one), less half the matches that come out of order. 1 for equal strings, two empty
 * strings included; 0 when exactly one is empty.
 */
export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  const left = Array.from(a);
  const right = Array.from(b);
  if (left.length === 0 || right.length === 0) return 0;

  const window = Math.max(0, Math.floor(Math.max(left.length, right.length) / 2) - 1);
  const rightMatched = new Array<boolean>(right.length).fill(false);
  const leftMatches: string[] = [];
  for (let i = 0; i < left.length; i++) {
    const from = Math.max(0, i - window);
    const to = Math.min(right.length - 1, i + window);
    for (let j = from; j <= to; j++) {
      if (!rightMatched[j] && right[j] === left[i]) {
        rightMatched[j] = true;
        leftMatches.push(left[i] ?? "");
        break;
      }
    }
  }
  const matches = leftMatches.length;
  if (matches === 0) return 0;

  const rightMatches = right.filter((_, j) => rightMatched[j]);
  let outOfOrder = 0;
  for (let k = 0; k < matches; k++) if (leftMatches[k] !== rightMatches[k]) outOfOrder++;
  const transpositions = outOfOrder / 2;

  return (
    (matches / left.length + matches / right.length + (matches - transpositions) / matches) / 3
  );
}

/**
 * Jaro-Winkler similarity in [0, 1]: `jaro`, raised for a shared prefix of up to 4 characters
 * when it's above 0.7. Symmetric. "kestral" and "kestrel" score about 0.94.
 */
export function jaroWinkler(a: string, b: string): number {
  const score = jaro(a, b);
  if (score <= BOOST_THRESHOLD) return score;
  const left = Array.from(a);
  const right = Array.from(b);
  let prefix = 0;
  const limit = Math.min(MAX_PREFIX, left.length, right.length);
  while (prefix < limit && left[prefix] === right[prefix]) prefix++;
  return score + prefix * PREFIX_SCALE * (1 - score);
}
