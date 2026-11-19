import { bothThemes, bothThemesParameters, themePanel } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { ActivityFeed } from "./activity-feed";
import { ACTIVITY } from "./fixtures";

const meta = {
  title: "Web/Capture/ActivityFeed",
  component: ActivityFeed,
  decorators: [bothThemes],
  parameters: { ...bothThemesParameters, layout: "padded" },
  args: { rows: ACTIVITY },
} satisfies Meta<typeof ActivityFeed>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every row type, with the one transient "Working…" row last. */
export const AllRowTypes: Story = {
  play: async ({ canvasElement }) => {
    const rows = themePanel(canvasElement).querySelectorAll("li[data-kind]");
    await expect([...rows].map((row) => row.getAttribute("data-kind"))).toEqual([
      "response",
      "connection",
      "connection",
      "error",
      "action",
      "action",
    ]);
  },
};

export const Empty: Story = { args: { rows: [] } };
