// The visible line on activities (Phase 6 spec decision 17): every note, task, and meeting a sync
// writes ends with "via Earshot · ref es_…". Where a CRM has no upsert for activities, it's how a
// retry finds its first try (decision 7), and it tells a CRM user where the note came from. Records
// (companies, contacts, deals) carry the marker in a property instead, never in their text.

/** What the line says before the marker. */
export const ACTIVITY_LINE_PREFIX = "via Earshot · ref ";

/** A marker in a body: `ref es_` and 20 base32 characters. */
const MARKER_IN_LINE = /\bref (es_[a-z2-7]{20})\b/g;

/** The line for a write's marker. */
export function activityLine(marker: string): string {
  return `${ACTIVITY_LINE_PREFIX}${marker}`;
}

/**
 * An activity's text with the line after it, a blank line between (just the line when there's no
 * text). With `maxChars`, the text is cut short with "…" so the whole fits; the line never is.
 */
export function withActivityLine(text: string | null, marker: string, maxChars?: number): string {
  const line = activityLine(marker);
  const body = (text ?? "").trim();
  if (body === "") return line;
  const whole = `${body}\n\n${line}`;
  if (maxChars === undefined || whole.length <= maxChars) return whole;
  const room = maxChars - line.length - 3;
  if (room <= 0) return line;
  return `${body.slice(0, room).trimEnd()}…\n\n${line}`;
}

/**
 * The marker an activity's body names in its line (the last, should the text quote another), or
 * null. Lenient about what surrounds it, since a CRM may turn the text into HTML.
 */
export function markerInBody(body: string): string | null {
  let found: string | null = null;
  for (const match of body.matchAll(MARKER_IN_LINE)) found = match[1] ?? found;
  return found;
}

/** Whether an activity's body carries the line for this marker. */
export function hasActivityLine(body: string, marker: string): boolean {
  for (const match of body.matchAll(MARKER_IN_LINE)) if (match[1] === marker) return true;
  return false;
}
