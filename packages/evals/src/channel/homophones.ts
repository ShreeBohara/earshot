// The simulator's homophone list (spec WP3 step 1): spellings a listener can't tell apart. The
// first spelling of each set is the commonest, the one a stream with no keyterms writes when it
// hears the sound. Most pairs also share a Double Metaphone code; "Sean" (SN) and "Shawn" (XN)
// don't, which is why the ground truth uses this list as well as the codes: the eval knows these
// sound alike even where the linker's phonetic keys say otherwise.
//
// The list covers the demo CRM's spelling groups, the heads its phonetic groups share, and the
// spec's examples. Add a set only for words that really are said the same way.

export const HOMOPHONES: readonly (readonly string[])[] = [
  // The spec's examples.
  ["Night", "Knight", "Nite"],
  ["Right", "Wright", "Rite"],
  ["Pier", "Peer"],
  ["Lee", "Li", "Leigh"],
  ["Sean", "Shawn", "Shaun"],
  // The demo CRM's contact groups.
  ["Catherine", "Katherine", "Kathryn"],
  ["Steven", "Stephen"],
  ["Sara", "Sarah"],
  ["Brian", "Bryan"],
  ["Alan", "Allan", "Allen"],
  ["John", "Jon"],
  ["Zoe", "Zoey"],
  ["Eric", "Erik", "Erick"],
  ["Aisha", "Ayesha"],
  ["Jeffrey", "Geoffrey"],
  ["Mohammed", "Mohamed", "Muhammad"],
  ["Thomas", "Tomas"],
  ["Raj", "Raaj"],
  ["Priya", "Preeya"],
  ["Mary", "Marie"],
  ["Dana", "Donna"],
  ["Hannah", "Hana"],
  // The demo CRM's company groups.
  ["Acme", "Akme", "Acmi"],
  ["Zenith", "Zenyth"],
  ["Sigma", "Sygma"],
  ["Kestrel", "Kestral"],
  ["Atmos", "Atmas"],
  ["Globalex", "Globelex"],
  // Everyday words in the demo CRM's names.
  ["Harbor", "Harbour"],
  ["Gray", "Grey"],
  ["Peak", "Peek"],
  ["Steel", "Steal"],
  ["Lane", "Lain"],
];

const SET_OF: ReadonlyMap<string, readonly string[]> = new Map(
  HOMOPHONES.flatMap((set) => set.map((word) => [word.toLowerCase(), set] as const)),
);

/** The homophone set a word belongs to (any case), or undefined. */
export function homophoneSet(word: string): readonly string[] | undefined {
  return SET_OF.get(word.toLowerCase());
}

/** Whether two words are listed as homophones of each other (any case; a word is its own). */
export function areHomophones(a: string, b: string): boolean {
  const set = homophoneSet(a);
  return set !== undefined && set === homophoneSet(b);
}

/** The commonest spelling of a word's sound: the first of its set, or the word itself. */
export function commonSpelling(word: string): string {
  return homophoneSet(word)?.[0] ?? word;
}
