// The pilot's consent text (Phase 5 spec WP7 step 2, WP7b): docs/pilot/consent.md, bundled as text
// when /pilot is built and read here into blocks, so the page shows the file's words exactly and
// can't drift from it. The file uses a small part of Markdown, and only that part is read: `#` and
// `##` headings, paragraphs, `- ` lists, and `*emphasis*`. Anything else throws when the page is
// built, rather than show the participant stray symbols.

/** A run of text, emphasized or not. `id` is its place in the text: a stable key. */
export type ConsentInline = { readonly id: string; readonly text: string; readonly em: boolean };

export type ConsentBlock =
  | {
      readonly id: string;
      readonly kind: "h1" | "h2" | "p";
      readonly inline: readonly ConsentInline[];
    }
  | {
      readonly id: string;
      readonly kind: "ul";
      readonly items: readonly { readonly id: string; readonly inline: readonly ConsentInline[] }[];
    };

/** `*emphasis*` within a line, the rest as it is. */
function inline(text: string, id: string): ConsentInline[] {
  const parts = text.split("*");
  if (parts.length % 2 === 0) throw new Error(`consent.md: an unclosed * in "${text}"`);
  return parts
    .map((part, index) => ({ id: `${id}.${index}`, text: part, em: index % 2 === 1 }))
    .filter((part) => part.text !== "");
}

/** Markdown this reader would show wrongly: links, code, bold, quotes, numbered lists, HTML. */
function unsupported(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    line.includes("**") ||
    line.includes("`") ||
    line.includes("](") ||
    line.includes("<") ||
    trimmed.startsWith(">") ||
    trimmed.startsWith("###") ||
    trimmed.startsWith("* ") ||
    trimmed.startsWith("+ ") ||
    /^\d+\. /.test(trimmed)
  );
}

/** consent.md as blocks, every word in its order. */
export function consentBlocks(markdown: string): ConsentBlock[] {
  const blocks: ConsentBlock[] = [];
  let paragraph: string[] = [];
  let items: string[] | null = null;
  const next = () => `b${blocks.length}`;
  const flush = () => {
    if (paragraph.length > 0) {
      const id = next();
      blocks.push({ id, kind: "p", inline: inline(paragraph.join(" "), id) });
    }
    paragraph = [];
    if (items) {
      const id = next();
      blocks.push({
        id,
        kind: "ul",
        items: items.map((item, index) => ({
          id: `${id}.${index}`,
          inline: inline(item, `${id}.${index}`),
        })),
      });
    }
    items = null;
  };
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    if (unsupported(line)) throw new Error(`consent.md: Markdown /pilot doesn't read: "${line}"`);
    if (line.trim() === "") {
      flush();
    } else if (line.startsWith("# ") || line.startsWith("## ")) {
      flush();
      const level = line.startsWith("# ") ? "h1" : "h2";
      const id = next();
      blocks.push({ id, kind: level, inline: inline(line.slice(level === "h1" ? 2 : 3), id) });
    } else if (line.startsWith("- ")) {
      if (paragraph.length > 0) flush();
      items ??= [];
      items.push(line.slice(2));
    } else if (items && line.startsWith("  ")) {
      // A list item's continuation line.
      items[items.length - 1] = `${items.at(-1)} ${line.trim()}`;
    } else {
      if (items) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

/** Every word the blocks show, in order: what a test compares with the file's own words. */
export function consentWords(blocks: readonly ConsentBlock[]): string[] {
  const text = blocks
    .flatMap((block) =>
      block.kind === "ul"
        ? block.items.flatMap((item) => item.inline.map((part) => part.text))
        : block.inline.map((part) => part.text),
    )
    .join(" ");
  return text.split(" ").filter((word) => word !== "");
}
