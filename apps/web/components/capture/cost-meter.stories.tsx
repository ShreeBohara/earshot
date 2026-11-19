import { bothThemes, bothThemesParameters } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { CostMeter } from "./cost-meter";

const meta = {
  title: "Web/Capture/CostMeter",
  component: CostMeter,
  decorators: [bothThemes],
  parameters: { ...bothThemesParameters, layout: "padded" },
  args: { costUsd: 0.0042, final: false },
} satisfies Meta<typeof CostMeter>;

export default meta;
type Story = StoryObj<typeof meta>;

/** While the debrief runs. */
export const Running: Story = {};

/** Once it ends. */
export const Final: Story = {
  args: { costUsd: 0.011, final: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByText(/This debrief cost/)[0]).toHaveTextContent(
      "This debrief cost $0.011",
    );
  },
};
