import { StatePill, type StatePillState } from "@earshot/ui/components/state-pill";
import type { Meta, StoryObj } from "@storybook/react-vite";

// Full class names, so Tailwind's scanner finds them.
const STATES: { state: Exclude<StatePillState, "neutral">; swatch: string; meaning: string }[] = [
  {
    state: "proposed",
    swatch: "bg-state-proposed text-state-proposed-foreground",
    meaning: "Heard on the call, waiting for review",
  },
  {
    state: "conflict",
    swatch: "bg-state-conflict text-state-conflict-foreground",
    meaning: "The CRM changed since the call",
  },
  {
    state: "synced",
    swatch: "bg-state-synced text-state-synced-foreground",
    meaning: "Written to the CRM, with evidence",
  },
  {
    state: "failed",
    swatch: "bg-state-failed text-state-failed-foreground",
    meaning: "The write failed and can be retried",
  },
];

function ThemePanel({ theme }: { theme: "light" | "dark" }) {
  return (
    <section
      data-theme={theme}
      aria-label={`${theme} theme`}
      className="flex flex-col gap-4 rounded-xl bg-background p-6 text-foreground ring-1 ring-border"
    >
      <p className="font-medium text-sm capitalize">{theme}</p>
      <ul className="flex flex-col gap-3">
        {STATES.map(({ state, swatch, meaning }) => (
          <li key={state} className="flex items-center gap-4">
            <span
              className={`flex size-10 shrink-0 items-center justify-center rounded-lg font-medium text-sm ${swatch}`}
            >
              Aa
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <code className="font-mono text-xs">--state-{state}</code>
              <span className="text-muted-foreground text-xs">{meaning}</span>
            </span>
            <StatePill state={state} />
          </li>
        ))}
      </ul>
    </section>
  );
}

const meta = {
  title: "Foundations/State colors",
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Earshot reserves color for meaning: blue proposed, amber conflict, green synced, red failed.
 * Each solid is at least 3:1 on the background and its foreground at least 4.5:1 on the solid.
 * Both themes render side by side (data-theme works on any element), so the page theme is
 * pinned to light.
 */
export const StateColors: Story = {
  name: "State colors",
  globals: { theme: "light" },
  render: () => (
    <div className="grid max-w-4xl gap-6 md:grid-cols-2">
      <ThemePanel theme="light" />
      <ThemePanel theme="dark" />
    </div>
  ),
};
