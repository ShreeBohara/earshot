// CRM mentions in a transcript line, and the evidence a proposal quotes from it. Phase 3 matches
// exact names and aliases only, ignoring case (core's EntityRef); Phase 4's entity linker
// replaces this. Mentions are labels, never links: the screen underlines them as mentions.
import type { EntityRef, ProposalField } from "@earshot/core";

export interface MentionRange {
  readonly start: number;
  readonly end: number;
  readonly entity: EntityRef;
}

/** A letter or digit in any script: what a name can't be glued to. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

function isBoundary(text: string, index: number): boolean {
  const char = text[index];
  return char === undefined || !WORD_CHAR.test(char);
}

/**
 * Every exact mention of an entity's name or alias in `text`, ignoring case, at word boundaries.
 * Longer names win where two overlap ("Acme Corp" over "Acme"), and mentions never overlap.
 */
export function findMentions(text: string, entities: readonly EntityRef[]): MentionRange[] {
  const lower = text.toLowerCase();
  // Lowercasing can change a string's length (İ becomes i̇); then indices wouldn't line up, so
  // match case-sensitively instead.
  const haystack = lower.length === text.length ? lower : text;
  const fold = (value: string) => (haystack === lower ? value.toLowerCase() : value);
  const needles = entities
    .flatMap((entity) => [entity.name, ...entity.aliases].map((name) => ({ name, entity })))
    .map(({ name, entity }) => ({ needle: fold(name.trim()), entity }))
    .filter(({ needle }) => needle.length > 0)
    .sort((a, b) => b.needle.length - a.needle.length);

  const found: MentionRange[] = [];
  for (const { needle, entity } of needles) {
    let from = 0;
    for (;;) {
      const start = haystack.indexOf(needle, from);
      if (start === -1) break;
      const end = start + needle.length;
      from = start + 1;
      if (!isBoundary(text, start - 1) || !isBoundary(text, end)) continue;
      if (found.some((m) => start < m.end && end > m.start)) continue;
      found.push({ start, end, entity });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** A run of a line's text: plain, a mention, quoted evidence, or both. */
export interface TextSegment {
  readonly text: string;
  readonly start: number;
  readonly mention: EntityRef | null;
  readonly highlight: boolean;
}

/** Splits `text` at every mention and highlight edge, so each run renders with one style. */
export function segmentText(
  text: string,
  mentions: readonly MentionRange[],
  highlights: readonly (readonly [number, number])[] = [],
): TextSegment[] {
  const clamp = (n: number) => Math.max(0, Math.min(text.length, n));
  const spans = highlights
    .map(([start, end]) => [clamp(start), clamp(end)] as const)
    .filter(([start, end]) => end > start);
  const cuts = new Set<number>([0, text.length]);
  for (const m of mentions) cuts.add(clamp(m.start)).add(clamp(m.end));
  for (const [start, end] of spans) cuts.add(start).add(end);
  const points = [...cuts].sort((a, b) => a - b);
  const segments: TextSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i] ?? 0;
    const end = points[i + 1] ?? start;
    if (end <= start) continue;
    segments.push({
      text: text.slice(start, end),
      start,
      mention: mentions.find((m) => m.start <= start && m.end >= end)?.entity ?? null,
      highlight: spans.some(([from, to]) => from <= start && to >= end),
    });
  }
  return segments;
}

/** Each utterance's quoted spans in a proposal's fields: what hovering its card highlights. */
export function evidenceSpans(
  fields: Readonly<Record<string, ProposalField>>,
): Map<string, [number, number][]> {
  const spans = new Map<string, [number, number][]>();
  for (const field of Object.values(fields)) {
    const { utteranceId, span } = field.evidence;
    spans.set(utteranceId, [...(spans.get(utteranceId) ?? []), [span[0], span[1]]]);
  }
  return spans;
}
