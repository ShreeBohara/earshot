// Where focus goes in the inbox (Phase 5 spec §4.8, decision 7). Pure: the page hands in each
// group's cards in the order they're shown (`cardOrder`), before the change.
//
// When a card leaves, focus moves to:
// 1. the next card in its group;
// 2. the previous card, if it was the last;
// 3. the first card of the next group;
// 4. the last card of the group before, when only earlier groups have cards left (the spec's
//    order stops at 3 and then "All caught up", which would claim nothing's left while cards are);
// 5. the "All caught up" heading.
// Focus never falls to <body>: every answer names something focusable. When "accept all" takes
// several cards at once, `focusAfterBatch` applies the same rules to the group as a whole.

export type FocusTarget =
  | { readonly kind: "card"; readonly id: string }
  | { readonly kind: "caught-up" };

const CAUGHT_UP: FocusTarget = { kind: "caught-up" };

function card(id: string): FocusTarget {
  return { kind: "card", id };
}

/** Where focus goes when the card `removed` leaves `groups` (each group's ids, before it left). */
export function focusAfterRemoval(
  groups: readonly (readonly string[])[],
  removed: string,
): FocusTarget {
  const groupIndex = groups.findIndex((group) => group.includes(removed));
  if (groupIndex < 0) {
    const first = groups.find((group) => group.length > 0)?.[0];
    return first === undefined ? CAUGHT_UP : card(first);
  }
  const group = groups[groupIndex] ?? [];
  const index = group.indexOf(removed);
  const next = group[index + 1];
  if (next !== undefined) return card(next);
  const previous = group[index - 1];
  if (previous !== undefined) return card(previous);
  for (const later of groups.slice(groupIndex + 1)) {
    const first = later[0];
    if (first !== undefined) return card(first);
  }
  for (const earlier of groups.slice(0, groupIndex).reverse()) {
    const last = earlier.at(-1);
    if (last !== undefined) return card(last);
  }
  return CAUGHT_UP;
}

/**
 * Where focus goes when several cards leave at once ("accept all", spec WP6): §4.8's rules for the
 * group as one removal. A batch is confirmed from its debrief's header, above the cards, so the
 * group is read again from its start:
 * 1. the first card the batch left in its group (what stays for review, top first);
 * 2. the first card of the next group;
 * 3. the last card of a group before it;
 * 4. the "All caught up" heading.
 * Never <body>, however many leave together.
 */
export function focusAfterBatch(
  groups: readonly (readonly string[])[],
  removed: ReadonlySet<string>,
): FocusTarget {
  const groupIndex = groups.findIndex((group) => group.some((id) => removed.has(id)));
  const stays = (group: readonly string[]) => group.filter((id) => !removed.has(id));
  if (groupIndex < 0) {
    const first = groups.map(stays).find((group) => group.length > 0)?.[0];
    return first === undefined ? CAUGHT_UP : card(first);
  }
  const left = stays(groups[groupIndex] ?? [])[0];
  if (left !== undefined) return card(left);
  for (const later of groups.slice(groupIndex + 1)) {
    const first = stays(later)[0];
    if (first !== undefined) return card(first);
  }
  for (const earlier of groups.slice(0, groupIndex).reverse()) {
    const last = stays(earlier).at(-1);
    if (last !== undefined) return card(last);
  }
  return CAUGHT_UP;
}

/**
 * The card j (`step` 1) or k (`step` -1) moves to from `current`, across groups, or null at either
 * end: the list doesn't wrap. From no card at all, j goes to the first card and k to the last.
 */
export function adjacentCard(
  groups: readonly (readonly string[])[],
  current: string | null,
  step: 1 | -1,
): string | null {
  const flat = groups.flat();
  if (flat.length === 0) return null;
  const index = current === null ? -1 : flat.indexOf(current);
  if (index < 0) return (step === 1 ? flat[0] : flat.at(-1)) ?? null;
  return flat[index + step] ?? null;
}
