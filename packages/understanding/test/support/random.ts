// Seeded randomness for the property and parity tests, so every run checks the same inputs. The
// generator is mulberry32, as @earshot/demo-crm's generator uses.

export type Random = () => number;

export function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: Random, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("pick from an empty list");
  return item;
}

export function int(random: Random, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

const SYLLABLES = (
  "ac me at mas mos las glo vex be lex nite knight pier peer kes tral trel sig syg ma da na " +
  "lee li north wind mer id ian sup ply cath er ine kath ryn moore zen ith yth har bor view wright " +
  "rite right marsh al sum mit ridge co corp inc group labs sean shawn shaun o a x qu ph"
).split(" ");

/** A made-up name of 1 to 4 words, each from 1 to 3 syllables, capitalized the way names are. */
export function randomName(random: Random): string {
  const words = Array.from({ length: int(random, 1, 4) }, () => {
    const word = Array.from({ length: int(random, 1, 3) }, () => pick(random, SYLLABLES)).join("");
    return random() < 0.7 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
  });
  return words.join(" ");
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const NOISE = [" ", "  ", "-", ".", ",", "'", "&", "_", "/", "(", ")", "!"];

/** A plausible mishearing or retyping of `name`: one to three edits of the kinds transcripts make. */
export function mutateName(random: Random, name: string): string {
  let text = name;
  for (let n = int(random, 1, 3); n > 0; n--) {
    const chars = Array.from(text);
    const at = int(random, 0, Math.max(0, chars.length - 1));
    switch (int(random, 0, 7)) {
      case 0: // substitute a letter
        chars[at] = pick(random, Array.from(LETTERS));
        break;
      case 1: // drop a character
        chars.splice(at, 1);
        break;
      case 2: // insert a letter
        chars.splice(at, 0, pick(random, Array.from(LETTERS)));
        break;
      case 3: // swap two neighbours
        if (at + 1 < chars.length)
          [chars[at], chars[at + 1]] = [chars[at + 1] ?? "", chars[at] ?? ""];
        break;
      case 4: // split a word, or join two
        if (chars[at] === " ") chars.splice(at, 1);
        else chars.splice(at, 0, " ");
        break;
      case 5: // drop or add a word
        text =
          random() < 0.5 ? text.split(" ").slice(0, -1).join(" ") : `${text} ${randomName(random)}`;
        continue;
      case 6: // punctuation
        chars.splice(at, 0, pick(random, NOISE));
        break;
      default: // case
        text = random() < 0.5 ? text.toUpperCase() : text.toLowerCase();
        continue;
    }
    text = chars.join("");
  }
  return text;
}

const ALPHABET = Array.from("aAbBcCdeEfgGhiIjklmMnNoOpqrsStTuvwxyzZ0123456789éüñßÉ");

/** Any short string: letters of both cases, digits, a few accented letters, spaces, punctuation. */
export function randomText(random: Random, maxLength = 16): string {
  const length = int(random, 0, maxLength);
  return Array.from({ length }, () =>
    random() < 0.75 ? pick(random, ALPHABET) : pick(random, NOISE),
  ).join("");
}
