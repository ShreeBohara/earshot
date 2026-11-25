// A contact's name as CRMs split it (Phase 6 spec §4.3: `name.firstName`, `name.lastName`): the
// simple rule, where the spec asks for it. The last word is the last name and the rest the first; a
// single word is a first name only. Particles ("van der Berg") and suffixes ("Jr.") aren't
// guessed at: the rep can fix a split in the CRM, and a guess would be wrong as often.

/** The first and last name of a full name; `last` is null for a single word. Null for no name. */
export function splitName(
  full: string,
): { readonly first: string; readonly last: string | null } | null {
  const words = full.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const last = words.pop();
  if (last === undefined) return null;
  if (words.length === 0) return { first: last, last: null };
  return { first: words.join(" "), last };
}
