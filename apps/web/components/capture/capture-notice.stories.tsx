import { bothThemes, bothThemesParameters, themePanel } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import {
  FakeEdgeNotice,
  MicrophoneNotice,
  NoKeyNotice,
  OfflineNotice,
  ProviderNotice,
  StartProblemNotice,
  VoiceNotice,
} from "./capture-notice";

// The capture screen's empty and error states, one story each.
const meta = {
  title: "Web/Capture/CaptureNotice",
  component: NoKeyNotice,
  decorators: [bothThemes],
  parameters: { ...bothThemesParameters, layout: "padded" },
  args: { missing: "both" },
} satisfies Meta<typeof NoKeyNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No key on this device: a link to Settings → Keys. */
export const NoKey: Story = {
  play: async ({ canvasElement }) => {
    const link = within(themePanel(canvasElement)).getByRole("link", {
      name: "Open Settings → Keys",
    });
    await expect(link).toHaveAttribute("href", "/settings/keys");
  },
};

export const MicrophoneDenied: Story = {
  render: () => <MicrophoneNotice code="permission_denied" onRetry={fn()} />,
  play: async ({ canvasElement }) => {
    const alert = within(themePanel(canvasElement)).getByRole("alert");
    await expect(alert).toHaveTextContent("The microphone is blocked");
  },
};

/** WebKit bug 319706: the mic fails while permission reads as granted. */
export const SafariMicrophoneStuck: Story = {
  render: () => <MicrophoneNotice code="permission_stuck" onRetry={fn()} />,
  play: async ({ canvasElement }) => {
    await expect(within(themePanel(canvasElement)).getByRole("alert")).toHaveTextContent(
      "quit Safari completely, reopen it",
    );
  },
};

export const NoMicrophone: Story = {
  render: () => <MicrophoneNotice code="device_unavailable" />,
};

export const ProviderRejectedKey: Story = {
  render: () => <ProviderNotice code="provider_rejected" />,
};

export const ProviderUnavailable: Story = {
  render: () => <ProviderNotice code="provider_unavailable" onRetry={fn()} />,
};

export const RateLimited: Story = { render: () => <VoiceNotice code="rate_limited" /> };

export const OfflineDuringSession: Story = { render: () => <OfflineNotice live /> };

export const OfflineBeforeStart: Story = { render: () => <OfflineNotice live={false} /> };

export const SessionRefused: Story = {
  render: () => (
    <StartProblemNotice
      problem={{ kind: "session", error: "too_many_requests", retryAfterSeconds: 300 }}
    />
  ),
};

export const KeysUnavailable: Story = {
  render: () => <StartProblemNotice problem={{ kind: "keys_unavailable" }} />,
};

/** Development only: fake mode, with no e2e edge Worker listening. */
export const FakeModeWithoutEdge: Story = {
  render: () => <FakeEdgeNotice scenarioUrl="http://localhost:8787/v1/e2e/scenario" />,
};
