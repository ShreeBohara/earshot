import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen } from "storybook/test";
import { ShortcutsDialog } from "./shortcuts-dialog";

// A dialog renders in a portal, so it can't sit in the two theme panels; it follows the toolbar.
const meta = {
  title: "Web/Capture/ShortcutsDialog",
  component: ShortcutsDialog,
  args: { open: true, onOpenChange: fn() },
} satisfies Meta<typeof ShortcutsDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  play: async () => {
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toHaveTextContent("Hold to talk");
    await expect(dialog).toHaveTextContent("End the debrief");
  },
};

export const OpenDark: Story = {
  globals: { theme: "dark" },
  play: async () => {
    await expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  },
};
