import type { StoredKeyMeta } from "@earshot/keys";
import { bothThemes, bothThemesParameters, themePanel } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { providerChoices } from "@/lib/capture/providers";
import { ProviderPickers } from "./provider-pickers";

const key = (
  provider: StoredKeyMeta["provider"],
  label = "default",
  last4 = "c4b6",
): StoredKeyMeta => ({
  provider,
  label,
  last4,
  addedAt: "2026-11-15T12:00:00.000Z",
});

const meta = {
  title: "Web/Capture/ProviderPickers",
  component: ProviderPickers,
  decorators: [bothThemes],
  parameters: { ...bothThemesParameters, layout: "padded" },
  args: {
    choices: providerChoices([
      key("assemblyai"),
      key("deepgram", "work", "9QxA"),
      key("groq"),
      key("anthropic"),
    ]),
    value: null,
    onChange: fn(),
  },
} satisfies Meta<typeof ProviderPickers>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Choices come from the keys on this device: provider, key label, last four characters. */
export const FromDeviceKeys: Story = {
  play: async ({ args, canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const stt = panel.getByLabelText("Speech-to-text");
    await expect(stt).toHaveValue("assemblyai:default");
    await userEvent.selectOptions(stt, "deepgram-flux:work");
    await expect(args.onChange).toHaveBeenCalledWith({
      stt: "deepgram-flux:work",
      llm: "groq:default",
    });
  },
};

/** No model key yet: the picker points to Settings → Keys. */
export const MissingModelKey: Story = {
  args: { choices: providerChoices([key("assemblyai")]) },
  play: async ({ canvasElement }) => {
    const link = within(themePanel(canvasElement)).getByRole("link", {
      name: "Add one in Settings → Keys",
    });
    await expect(link).toHaveAttribute("href", "/settings/keys");
  },
};

export const Disabled: Story = { args: { disabled: true } };
