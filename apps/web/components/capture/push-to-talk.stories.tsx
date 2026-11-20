import { bothThemes, bothThemesParameters, themePanel } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { PushToTalkButton } from "./push-to-talk";

const meta = {
  title: "Web/Capture/PushToTalkButton",
  component: PushToTalkButton,
  decorators: [bothThemes],
  parameters: { ...bothThemesParameters, layout: "padded" },
  args: { pressed: false, mode: "push_to_talk", onPress: fn(), onRelease: fn() },
} satisfies Meta<typeof PushToTalkButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Ready: hold the button (or Space) while speaking. */
export const Ready: Story = {
  play: async ({ args, canvasElement }) => {
    const button = within(themePanel(canvasElement)).getByRole("button", { name: "Push to talk" });
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(button).toHaveAttribute("aria-keyshortcuts", "Space");
    const user = userEvent.setup();
    await user.pointer({ keys: "[MouseLeft>]", target: button });
    await expect(args.onPress).toHaveBeenCalledTimes(1);
    await expect(args.onRelease).not.toHaveBeenCalled();
    await user.pointer({ keys: "[/MouseLeft]", target: button });
    await expect(args.onRelease).toHaveBeenCalledTimes(1);
  },
};

export const Held: Story = { args: { pressed: true } };

/** Before capture is armed, or after a microphone error. */
export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ args, canvasElement }) => {
    const button = within(themePanel(canvasElement)).getByRole("button", { name: "Push to talk" });
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.pointer({ keys: "[MouseLeft]", target: button });
    await expect(args.onPress).not.toHaveBeenCalled();
  },
};

export const HandsFree: Story = { args: { mode: "hands_free" } };

/** The docked bar's size: 44 px, captions hidden. */
export const Small: Story = { args: { size: "sm", hideCaption: true } };
