import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { HomeScreenHint } from "./home-screen-hint";

const meta = {
  title: "Web/Keys/HomeScreenHint",
  component: HomeScreenHint,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HomeScreenHint>;

export default meta;
type Story = StoryObj<typeof meta>;

/** What iOS Safari shows, outside a Home Screen app. */
export const Shown: Story = {
  args: { show: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/Safari can delete keys kept on this device/)).toBeVisible();
    await expect(canvas.getByText(/add your keys there/)).toBeVisible();
  },
};

export const ShownDark: Story = {
  ...Shown,
  name: "Shown (dark)",
  globals: { theme: "dark" },
};

/** Everywhere else, nothing. */
export const Hidden: Story = {
  args: { show: false },
  play: async ({ canvas }) => {
    await expect(canvas.queryByText(/Safari/)).toBeNull();
  },
};
