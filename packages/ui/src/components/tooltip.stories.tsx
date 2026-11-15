import { Button } from "@earshot/ui/components/button";
import { Kbd } from "@earshot/ui/components/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@earshot/ui/components/tooltip";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QuoteIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { expect, screen, waitFor } from "storybook/test";

const meta = {
  title: "Components/Tooltip",
  component: Tooltip,
  decorators: [
    (Story) => (
      <TooltipProvider>
        <Story />
      </TooltipProvider>
    ),
  ],
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * An evidence hint. Tooltips are visual only, so the trigger's accessible name says the same
 * thing; anything a user must read belongs in a Popover.
 */
function EvidenceTooltip(props: ComponentProps<typeof Tooltip>) {
  return (
    <Tooltip {...props}>
      <TooltipTrigger
        render={<Button variant="outline" size="icon" />}
        aria-label="Evidence: “we can do forty-eight”, 12:41"
      >
        <QuoteIcon aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>
        “we can do forty-eight”, 12:41 <Kbd>E</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

export const Open: Story = {
  args: { defaultOpen: true },
  parameters: { layout: "padded" },
  render: (args) => (
    <div className="flex min-h-32 items-end justify-center">
      <EvidenceTooltip {...args} />
    </div>
  ),
};

export const OpenDark: Story = {
  ...Open,
  name: "Open (dark)",
  globals: { theme: "dark" },
};

/** Keyboard focus shows the tooltip, not just hover; Escape hides it again. */
export const ShowsOnFocus: Story = {
  render: (args) => <EvidenceTooltip {...args} />,
  play: async ({ canvas, userEvent, step }) => {
    const trigger = canvas.getByRole("button", { name: /^Evidence/ });

    await step("Focus shows it", async () => {
      await userEvent.tab();
      await expect(trigger).toHaveFocus();
      await waitFor(() => expect(screen.getByText(/we can do forty-eight/)).toBeVisible());
    });

    await step("Escape hides it, and focus stays on the trigger", async () => {
      await userEvent.keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.queryByText(/we can do forty-eight/)).not.toBeInTheDocument(),
      );
      await expect(trigger).toHaveFocus();
    });
  },
};
