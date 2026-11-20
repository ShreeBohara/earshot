// A turn as the generator builds it: segments that read the same for every witness ("lit"), or
// differently ("var": a name as said, as the biased stream wrote it, and as the second witness
// did; an amount a stream writes in digits), with field markers around the words a field quotes.
// Rendering a turn for one version gives its text and where each field and name sits, so every
// quote is cut from the text it must be a substring of.
//
// Templates are written in a small notation (templates.ts): `{SLOT}` is filled by the generator,
// and `[field:…]` marks the words a field quotes. The parser scans character by character.

export type Version = "said" | "biased" | "unbiased";

export type Seg =
  /** `frozen`: words a disfluency mustn't break up, such as a self-correction's. */
  | { readonly kind: "lit"; readonly text: string; readonly frozen?: true }
  | {
      readonly kind: "var";
      readonly said: string;
      readonly biased: string;
      readonly unbiased: string;
      /**
       * A name the ground truth needs the place of: a proposal's target words (`mention:0`), or
       * the company said with them (`company:0`), numbered by the proposal's place in the turn.
       */
      readonly role?: string;
    }
  | { readonly kind: "open"; readonly field: string }
  | { readonly kind: "close"; readonly field: string };

export const lit = (text: string, frozen = false): Seg =>
  frozen ? { kind: "lit", text, frozen: true } : { kind: "lit", text };

/** A template's parts before its slots are filled. */
export type Part =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "slot"; readonly name: string }
  | { readonly kind: "open"; readonly field: string }
  | { readonly kind: "close" };

/** Parses the template notation; throws on an unbalanced bracket, which is a typo. */
export function parseTemplate(text: string): Part[] {
  const parts: Part[] = [];
  let buffer = "";
  let depth = 0;
  const flush = () => {
    if (buffer !== "") parts.push({ kind: "text", text: buffer });
    buffer = "";
  };
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (char === "{") {
      const end = text.indexOf("}", i);
      if (end < 0) throw new Error(`unclosed slot in "${text}"`);
      flush();
      parts.push({ kind: "slot", name: text.slice(i + 1, end) });
      i = end;
    } else if (char === "[") {
      const colon = text.indexOf(":", i);
      if (colon < 0) throw new Error(`field without a name in "${text}"`);
      flush();
      parts.push({ kind: "open", field: text.slice(i + 1, colon) });
      depth++;
      i = colon;
    } else if (char === "]") {
      if (depth === 0) throw new Error(`unopened field in "${text}"`);
      flush();
      parts.push({ kind: "close" });
      depth--;
    } else {
      buffer += char;
    }
  }
  flush();
  if (depth !== 0) throw new Error(`unclosed field in "${text}"`);
  return parts;
}

/** The fields and slots a template uses. */
export function templateFields(parts: readonly Part[]): string[] {
  return parts.flatMap((part) => (part.kind === "open" ? [part.field] : []));
}

export function templateSlots(parts: readonly Part[]): string[] {
  return parts.flatMap((part) => (part.kind === "slot" ? [part.name] : []));
}

/**
 * Fills a template's slots. A field whose name is in `drop` is left out with everything inside
 * it, and the space before it goes too ("I owe Dana the quote [dueDate:{DUE}]." without a due
 * date reads "I owe Dana the quote.").
 */
export function fillTemplate(
  parts: readonly Part[],
  fill: (slot: string) => Seg | readonly Seg[],
  drop: ReadonlySet<string> = new Set(),
): Seg[] {
  const out: Seg[] = [];
  const open: string[] = [];
  let skipping = 0;
  for (const part of parts) {
    if (part.kind === "open") {
      if (skipping > 0 || drop.has(part.field)) {
        if (skipping === 0) trimTrailingSpace(out);
        skipping++;
        open.push(part.field);
        continue;
      }
      open.push(part.field);
      out.push({ kind: "open", field: part.field });
      continue;
    }
    if (part.kind === "close") {
      const field = open.pop() as string;
      if (skipping > 0) {
        skipping--;
        continue;
      }
      out.push({ kind: "close", field });
      continue;
    }
    if (skipping > 0) continue;
    if (part.kind === "text") out.push(lit(part.text));
    else {
      const filled = fill(part.name);
      out.push(...(Array.isArray(filled) ? filled : [filled as Seg]));
    }
  }
  return out;
}

function trimTrailingSpace(segs: Seg[]): void {
  const last = segs.at(-1);
  if (last?.kind === "lit" && last.text.endsWith(" ")) {
    segs[segs.length - 1] = lit(last.text.slice(0, -1));
  }
}

export interface Rendered {
  readonly text: string;
  /** Each field's `[start, end)` in `text`. */
  readonly fields: ReadonlyMap<string, readonly [number, number]>;
  /** Each role's `[start, end)` in `text`: the first segment that has it. */
  readonly roles: ReadonlyMap<string, readonly [number, number]>;
}

/** A turn's text as one version has it, with where each field and named role sits. */
export function render(segs: readonly Seg[], version: Version): Rendered {
  let text = "";
  const fields = new Map<string, [number, number]>();
  const opened = new Map<string, number>();
  const roles = new Map<string, [number, number]>();
  for (const seg of segs) {
    if (seg.kind === "open") opened.set(seg.field, text.length);
    else if (seg.kind === "close") fields.set(seg.field, [opened.get(seg.field) ?? 0, text.length]);
    else if (seg.kind === "lit") text += seg.text;
    else {
      const words = seg[version];
      if (seg.role && !roles.has(seg.role))
        roles.set(seg.role, [text.length, text.length + words.length]);
      text += words;
    }
  }
  return { text, fields, roles };
}

/** The words of a field (or role) span, as one version renders them. */
export function spanOf(rendered: Rendered, span: readonly [number, number]): string {
  return rendered.text.slice(span[0], span[1]);
}

/** Two turns' segments as one turn: the second sentence after the first. */
export function joinSentences(first: readonly Seg[], second: readonly Seg[]): Seg[] {
  return [...first, lit(" "), ...second];
}

/** Whether a version's text needs no space cleanup: single spaces, trimmed. */
export function isTidy(text: string): boolean {
  return text === text.replace(/\s+/g, " ").trim() && !text.includes(" ,") && !text.includes(" .");
}
