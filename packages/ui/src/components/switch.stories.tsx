import { Switch } from "@earshot/ui/components/switch";
import { bothThemes, bothThemesParameters, themePanel } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useId } from "react";
import { expect, userEvent, within } from "storybook/test";

function ShortcutsSwitch() {
  const id = useId();
  return (
    <div className="flex items-center gap-3">
      <span id={id} className="text-sm">
        Single-key shortcuts
      </span>
      <Switch aria-labelledby={id} defaultChecked />
    </div>
  );
}

const meta = {
  title: "Components/Switch",
  component: ShortcutsSwitch,
  decorators: [bothThemes],
  parameters: { ...bothThemesParameters, layout: "padded" },
} satisfies Meta<typeof ShortcutsSwitch>;

export default meta;
type Story = StoryObj<typeof meta>;

/** role="switch", named by its label, toggled by a click or Space. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const toggle = panel.getByRole("switch", { name: "Single-key shortcuts" });
    await expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    await expect(toggle).not.toBeChecked();
    await userEvent.keyboard(" ");
    await expect(toggle).toBeChecked();
  },
};
