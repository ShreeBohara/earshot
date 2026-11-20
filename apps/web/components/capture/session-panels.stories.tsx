import { bothThemes, bothThemesParameters, themePanel } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { demoState, ENTITIES } from "./fixtures";
import { SessionPanels } from "./session-panels";

// The panels as the live screen and WP10's replay render them: a real SessionStore's state.
const meta = {
  title: "Web/Capture/SessionPanels",
  component: SessionPanels,
  decorators: [bothThemes],
  parameters: { ...bothThemesParameters, layout: "fullscreen" },
  args: { state: demoState(), entities: ENTITIES, partial: null },
} satisfies Meta<typeof SessionPanels>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Hovering a proposal marks the words it came from. */
export const Live: Story = {
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const [contact] = panel.getAllByRole("article");
    await userEvent.hover(contact as HTMLElement);
    await waitFor(() =>
      expect(
        [...themePanel(canvasElement).querySelectorAll("mark")].map((m) => m.textContent),
      ).toEqual(["Dana Lee", "VP of Operations"]),
    );
  },
};

export const Starting: Story = { args: { state: null } };

export const Replay: Story = { args: { state: demoState({ reviewed: true }), showReview: true } };
