import { Badge } from "@earshot/ui/components/badge";
import type { Meta, StoryObj } from "@storybook/react-vite";

const VARIANTS = [
  "default",
  "secondary",
  "destructive",
  "outline",
  "ghost",
  "link",
  "proposed",
  "conflict",
  "synced",
  "failed",
  "neutral",
] as const;

const meta = {
  title: "Components/Badge",
  component: Badge,
  args: { children: "Badge" },
  argTypes: { variant: { control: "select", options: VARIANTS } },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

/** shadcn's variants, then Earshot's state variants (StatePill builds on these). */
export const Variants: Story = {
  render: () => (
    <div className="flex max-w-xl flex-wrap items-center gap-2">
      {VARIANTS.map((variant) => (
        <Badge key={variant} variant={variant}>
          {variant}
        </Badge>
      ))}
      <Badge variant="outline" render={<a href="#changelog">As a link</a>} />
    </div>
  ),
};

export const VariantsDark: Story = {
  ...Variants,
  name: "Variants (dark)",
  globals: { theme: "dark" },
};
