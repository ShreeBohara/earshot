// The decoys (spec WP3 step 2): names the demo CRM doesn't have, said as new companies and new
// contacts. About two-thirds sound like a CRM name ("Pierce Logistics" beside Pier Logistics);
// the rest are unrelated. Like the demo CRM's own names, each is invented and generic: no real
// company, no well-known brand or fictional brand, no public figure. A test checks that each is
// absent from the demo CRM and that it sounds like what it says it sounds like; whether a name
// is fictional is checked by review, against that rule.
import type { EntityKind } from "@earshot/core";
import { normalizeName } from "@earshot/understanding/names";
import { alignPhrase, soundWords, wordLikeness } from "../channel/sound";
import { entitiesOfKind, spokenForms } from "./entities";

export interface Decoy {
  readonly text: string;
  readonly kind: Extract<EntityKind, "company" | "contact">;
  /** The CRM record it was made to sound like; null for an unrelated name. */
  readonly like: string | null;
}

const company = (text: string, like: string | null = null): Decoy => ({
  text,
  kind: "company",
  like,
});
const contact = (text: string, like: string | null = null): Decoy => ({
  text,
  kind: "contact",
  like,
});

export const DECOYS: readonly Decoy[] = [
  // Companies a word away from a CRM name: one word one consonant off.
  company("Quarry Lake Media", "co_020"),
  company("Basil Mining", "co_049"),
  company("Copperline Retail", "co_041"),
  company("Cobalt Bridge Energy", "co_057"),
  company("Ironridge Textiles", "co_047"),
  company("Granite Slate Builders", "co_059"),
  company("Maple & Pine Grocers", "co_025"),
  company("Willowbank Pharma", "co_007"),
  company("Lanton Hospitality", "co_053"),
  company("Ferndale Education", "co_051"),
  company("Barrow Robotics", "co_039"),
  company("Whistle Software", "co_023"),
  company("Oakmere Insurance", "co_013"),
  company("Juniper Bay Telecare", "co_004"),
  company("Opal Strand Studios", "co_030"),
  company("Delta Crossing Trail", "co_038"),
  company("Northwood Labs", "co_021"),
  company("Summit Rock Capital", "co_019"),
  company("Harborside Health", "co_001"),
  company("Redwood Analysts", "co_060"),
  company("Meridian Steel Co", "co_043"),
  company("Pacific Crown Energy", "co_048"),
  company("Coastal Paper Systems", "co_054"),
  company("Bay Arbor Associates", "co_050"),
  company("Atlas Fleet", "co_005"),
  company("Glovek Systems", "co_022"),
  company("Marlow Medical", "co_058"),
  company("Atmos Industries", "co_009"),
  company("Knightley Security", "co_028"),
  company("Wrighton Fabrication", "co_018"),
  company("Acme Dynamos", "co_011"),
  // Companies that share a CRM name's head word, or a near one, and nothing else.
  company("Atmo Systems", "co_009"),
  company("Pierce Logistics", "co_003"),
  company("Harborview Hotels", "co_001"),
  company("Summit Peak Medical", "co_024"),
  // Contacts a word away from a CRM contact.
  contact("Sean Murray", "ct_134"),
  contact("Kathryn Morse", "ct_064"),
  contact("Bryan Kelly", "ct_080"),
  contact("Erik Olsen", "ct_033"),
  contact("Zoe Parker", "ct_111"),
  contact("Priya Nash", "ct_118"),
  contact("Marie Ellis", "ct_004"),
  contact("Geoffrey Walton", "ct_092"),
  contact("Steven Clarkson", "ct_059"),
  contact("Ravi Patel", "ct_068"),
  contact("Aisha Kent", "ct_007"),
  contact("Thomas Bergman", "ct_005"),
  contact("Jon Whitley", "ct_024"),
  contact("Dana Lewis", "ct_045"),
  contact("Sara Conn", "ct_141"),
  contact("Alan Fisher", "ct_038"),
  contact("Hana Okoro", "ct_001"),
  contact("Owen Moran", "ct_020"),
  contact("Callum Whitford", "ct_097"),
  // Unrelated companies.
  company("Brightwater Ceramics"),
  company("Saffron Loop Studios"),
  company("Hollowpine Outfitters"),
  company("Quillfeather Books"),
  company("Emberline Furniture"),
  company("Bellwether Cartography"),
  company("Driftwood Cycles"),
  company("Kittiwake Glassworks"),
  company("Thimbleberry Bakehouse"),
  company("Moonlit Orchard Cider"),
  company("Lumen & Fable Press"),
  company("Halcyon Freightworks"),
  company("Pinecrest Veterinary"),
  // Unrelated contacts.
  contact("Beatriz Lindgren"),
  contact("Hiroshi Vance"),
  contact("Olu Adebayo"),
  contact("Ines Marchetti"),
  contact("Tobiah Fairweather"),
  contact("Keiko Brandvold"),
  contact("Rosalind Achterberg"),
  contact("Omar Delacroix"),
  contact("Saoirse Kavanagh"),
  contact("Lars Thorvaldsen"),
  contact("Amara Nwosu"),
  contact("Esperanza Quiroga"),
  contact("Wendell Okonkwo"),
];

/** How close a company's first word must be to a CRM form's to sound alike: one edit in three. */
export const ALIKE_HEAD_DISTANCE = 0.34;

/**
 * The CRM records of a kind a name sounds like without sounding the same: a full spoken form
 * with every word the same sound but one, which is near; or, for a company, a form whose first
 * word is the same sound or within `ALIKE_HEAD_DISTANCE` ("Atmo Systems" beside Atmos
 * Industrial). A person's first name alone doesn't count: plenty of contacts share one.
 */
export function alikeTo(text: string, kind: EntityKind): string[] {
  const words = soundWords(text);
  const head = words[0];
  const ids: string[] = [];
  for (const entity of entitiesOfKind(kind)) {
    const alike = spokenForms(entity).some((form) => {
      const formWords = soundWords(form);
      const match = alignPhrase(words, formWords, { prefix: false, maxNear: 1 });
      if (match !== null && match.near === 1) return true;
      const formHead = formWords[0];
      return (
        kind === "company" &&
        head !== undefined &&
        formHead !== undefined &&
        wordLikeness(head, formHead).distance <= ALIKE_HEAD_DISTANCE
      );
    });
    if (alike) ids.push(entity.id);
  }
  return ids;
}

/** Whether a name is one of a kind's spoken forms once normalized: then it isn't absent. */
export function inDemoCrm(text: string, kind: EntityKind): boolean {
  const key = normalizeName(text);
  return entitiesOfKind(kind).some((entity) =>
    spokenForms(entity).some((form) => normalizeName(form) === key),
  );
}
