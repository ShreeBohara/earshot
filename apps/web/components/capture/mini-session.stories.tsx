import { staticLevels } from "@earshot/ui/components/orb";
import { bothThemes, bothThemesParameters, themePanel } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { MiniSession } from "./mini-session";

const meta = {
  title: "Web/Capture/MiniSession",
  component: MiniSession,
  decorators: [bothThemes],
  parameters: { ...bothThemesParameters, layout: "padded" },
  args: {
    levels: staticLevels({ mic: 0.35, agent: 0 }),
    status: "Ready: hold to talk",
    lastLine: "I need to send Dana the pricing breakdown by Thursday.",
    proposalCount: 3,
    mode: "push_to_talk",
    pressed: false,
    canTalk: true,
    suspended: false,
    fixed: false,
    onPress: fn(),
    onRelease: fn(),
    onResume: fn(),
    onEnd: fn(),
  },
} satisfies Meta<typeof MiniSession>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Docked while the rep browses: the last line, the count, push-to-talk, Open, and End. */
export const Docked: Story = {
  play: async ({ canvasElement }) => {
    const bar = within(themePanel(canvasElement)).getByRole("complementary", {
      name: "Debrief in progress",
    });
    await expect(within(bar).getByRole("button", { name: "Push to talk" })).toBeVisible();
    await expect(within(bar).getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/capture",
    );
    await expect(within(bar).getByText("3")).toBeInTheDocument();
  },
};

export const Listening: Story = { args: { pressed: true, status: "Listening" } };

/** iOS home-screen app after navigating: WebKit stopped the mic, so the bar offers Resume. */
export const PausedByNavigation: Story = {
  args: { suspended: true, status: "Paused", canTalk: false },
};

export const NothingSaidYet: Story = { args: { lastLine: null, proposalCount: 0 } };
