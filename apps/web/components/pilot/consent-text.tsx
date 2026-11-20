import type { ConsentBlock, ConsentInline } from "@/lib/pilot/consent";

function Inline({ parts }: { parts: readonly ConsentInline[] }) {
  return (
    <>
      {parts.map((part) =>
        part.em ? <em key={part.id}>{part.text}</em> : <span key={part.id}>{part.text}</span>,
      )}
    </>
  );
}

function Block({ block }: { block: ConsentBlock }) {
  if (block.kind === "ul") {
    return (
      <ul className="flex list-disc flex-col gap-1 ps-5 text-muted-foreground">
        {block.items.map((item) => (
          <li key={item.id}>
            <Inline parts={item.inline} />
          </li>
        ))}
      </ul>
    );
  }
  if (block.kind === "h1") {
    return (
      <h1 className="font-serif text-4xl tracking-tight">
        <Inline parts={block.inline} />
      </h1>
    );
  }
  if (block.kind === "h2") {
    return (
      <h2 className="pt-2 font-medium text-base">
        <Inline parts={block.inline} />
      </h2>
    );
  }
  return (
    <p className="text-muted-foreground">
      <Inline parts={block.inline} />
    </p>
  );
}

/**
 * docs/pilot/consent.md as the pilot's first screen shows it (spec WP7 step 2, WP7b): its own
 * heading as the page's h1, its sections, paragraphs, and lists, word for word.
 */
export function ConsentText({ blocks }: { blocks: readonly ConsentBlock[] }) {
  return (
    <div className="flex flex-col gap-4 text-pretty leading-relaxed" data-slot="consent">
      {blocks.map((block) => (
        <Block key={block.id} block={block} />
      ))}
    </div>
  );
}
