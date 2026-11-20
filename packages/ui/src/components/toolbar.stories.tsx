import { Button } from "@earshot/ui/components/button";
import { Toolbar, ToolbarButton, ToolbarSeparator } from "@earshot/ui/components/toolbar";
import { bothThemes, bothThemesParameters, themePanel } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { CheckIcon, PencilIcon, XIcon } from "lucide-react";
import { expect, userEvent, within } from "storybook/test";

function CardActions() {
  return (
    <Toolbar aria-label="Actions: task">
      <ToolbarButton render={<Button size="sm" />}>
        <CheckIcon aria-hidden="true" data-icon="inline-start" />
        Accept
      </ToolbarButton>
      <ToolbarButton render={<Button size="sm" variant="outline" />}>
        <PencilIcon aria-hidden="true" data-icon="inline-start" />
        Edit
      </ToolbarButton>
      <ToolbarSeparator />
      <ToolbarButton render={<Button size="sm" variant="outline" />}>
        <XIcon aria-hidden="true" data-icon="inline-start" />
        Reject
      </ToolbarButton>
    </Toolbar>
  );
}

const meta = {
  title: "Components/Toolbar",
  component: CardActions,
  decorators: [bothThemes],
  parameters: { ...bothThemesParameters, layout: "padded" },
} satisfies Meta<typeof CardActions>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One tab stop for the row; the arrow keys move between its buttons. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const toolbar = panel.getByRole("toolbar", { name: "Actions: task" });
    const [accept, edit] = within(toolbar).getAllByRole("button");
    accept?.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(edit).toHaveFocus();
  },
};
