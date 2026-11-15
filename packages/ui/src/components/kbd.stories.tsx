import { Kbd, KbdGroup } from "@earshot/ui/components/kbd";
import type { Meta, StoryObj } from "@storybook/react-vite";

const INBOX_SHORTCUTS = [
  { key: "J", action: "Next proposal" },
  { key: "K", action: "Previous proposal" },
  { key: "A", action: "Approve" },
  { key: "E", action: "Edit" },
  { key: "R", action: "Reject" },
] as const;

const meta = {
  title: "Components/Kbd",
  component: Kbd,
  args: { children: "J" },
} satisfies Meta<typeof Kbd>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Single keys, a key combination, and the inbox shortcuts. */
export const Variants: Story = {
  render: () => (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex items-center gap-2">
        <Kbd>J</Kbd>
        <Kbd>Esc</Kbd>
        <Kbd>⌘</Kbd>
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </div>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
        {INBOX_SHORTCUTS.map(({ key, action }) => (
          <div key={key} className="contents">
            <dt>
              <Kbd>{key}</Kbd>
            </dt>
            <dd>{action}</dd>
          </div>
        ))}
      </dl>
    </div>
  ),
};

export const VariantsDark: Story = {
  ...Variants,
  name: "Variants (dark)",
  globals: { theme: "dark" },
};
