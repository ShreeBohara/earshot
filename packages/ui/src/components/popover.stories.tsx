import { Button } from "@earshot/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@earshot/ui/components/popover";
import { StatePill } from "@earshot/ui/components/state-pill";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";
import { expect, screen, waitFor } from "storybook/test";

const meta = {
  title: "Components/Popover",
  component: Popover,
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A conflict pill opens the alternatives: what the call said, and what the CRM says now. */
function ConflictPopover(props: ComponentProps<typeof Popover>) {
  return (
    <Popover {...props}>
      <PopoverTrigger
        render={<StatePill state="conflict" render={<button type="button" />} />}
        aria-label="Amount conflict: show alternatives"
      >
        Conflict
      </PopoverTrigger>
      <PopoverContent>
        <PopoverHeader>
          <PopoverTitle>Amount changed in the CRM</PopoverTitle>
          <PopoverDescription>Pick the value to sync.</PopoverDescription>
        </PopoverHeader>
        <div className="flex flex-col gap-2">
          <Button variant="outline" className="justify-between">
            From the call <span className="font-mono tabular-nums">$48,000</span>
          </Button>
          <Button variant="outline" className="justify-between">
            In HubSpot now <span className="font-mono tabular-nums">$40,000</span>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export const Open: Story = {
  args: { defaultOpen: true },
  parameters: { layout: "padded" },
  render: (args) => (
    <div className="flex min-h-56 justify-center">
      <ConflictPopover {...args} />
    </div>
  ),
};

export const OpenDark: Story = {
  ...Open,
  name: "Open (dark)",
  globals: { theme: "dark" },
};

/** Enter opens it, Escape closes it, and focus goes back to the pill. */
export const KeyboardOpenAndClose: Story = {
  render: (args) => <ConflictPopover {...args} />,
  play: async ({ canvas, userEvent, step }) => {
    const trigger = canvas.getByRole("button", { name: "Amount conflict: show alternatives" });

    await step("Enter opens the popover", async () => {
      await userEvent.tab();
      await expect(trigger).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(screen.getByText("Amount changed in the CRM")).toBeVisible());
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
    });

    await step("Escape closes it and focus returns to the pill", async () => {
      await userEvent.keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.queryByText("Amount changed in the CRM")).not.toBeInTheDocument(),
      );
      await expect(trigger).toHaveFocus();
    });
  },
};
