import { Tabs, TabsContent, TabsList, TabsTrigger } from "@earshot/ui/components/tabs";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { KeyRoundIcon, RefreshCwIcon, SettingsIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { expect } from "storybook/test";

const meta = {
  title: "Components/Tabs",
  component: Tabs,
  parameters: { layout: "padded" },
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

function SettingsTabs({
  variant,
  ...props
}: ComponentProps<typeof Tabs> & { variant?: "default" | "line" }) {
  return (
    <Tabs defaultValue="general" {...props}>
      <TabsList variant={variant} aria-label="Settings">
        <TabsTrigger value="general">
          <SettingsIcon data-icon="inline-start" aria-hidden="true" />
          General
        </TabsTrigger>
        <TabsTrigger value="keys">
          <KeyRoundIcon data-icon="inline-start" aria-hidden="true" />
          Keys
        </TabsTrigger>
        <TabsTrigger value="sync">
          <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
          Sync
        </TabsTrigger>
        <TabsTrigger value="billing" disabled>
          Billing
        </TabsTrigger>
      </TabsList>
      <TabsContent value="general">Workspace name, timezone, and theme.</TabsContent>
      <TabsContent value="keys">Your provider keys, stored on this device.</TabsContent>
      <TabsContent value="sync">Which CRM fields Earshot may write.</TabsContent>
      <TabsContent value="billing">Not available on the free plan.</TabsContent>
    </Tabs>
  );
}

/** Default and line lists, horizontal and vertical, with icons and a disabled tab. */
export const Variants: Story = {
  render: () => (
    <div className="grid max-w-2xl gap-8 md:grid-cols-2">
      <SettingsTabs />
      <SettingsTabs variant="line" />
      <SettingsTabs orientation="vertical" />
      <SettingsTabs orientation="vertical" variant="line" />
    </div>
  ),
};

export const VariantsDark: Story = {
  ...Variants,
  name: "Variants (dark)",
  globals: { theme: "dark" },
};

/**
 * Arrow keys move focus between tabs and wrap around; Enter selects. A disabled tab still takes
 * focus (so screen reader users find it) but can't be selected.
 */
export const ArrowKeys: Story = {
  render: () => <SettingsTabs />,
  play: async ({ canvas, userEvent, step }) => {
    const general = canvas.getByRole("tab", { name: "General" });
    const keys = canvas.getByRole("tab", { name: "Keys" });
    const sync = canvas.getByRole("tab", { name: "Sync" });
    const billing = canvas.getByRole("tab", { name: "Billing" });

    await step("Tab lands on the selected tab", async () => {
      await userEvent.tab();
      await expect(general).toHaveFocus();
      await expect(general).toHaveAttribute("aria-selected", "true");
    });

    await step("ArrowRight moves focus; Enter selects", async () => {
      await userEvent.keyboard("{ArrowRight}");
      await expect(keys).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await expect(keys).toHaveAttribute("aria-selected", "true");
      await expect(canvas.getByRole("tabpanel", { name: "Keys" })).toHaveTextContent(
        "Your provider keys",
      );
    });

    await step("The disabled tab takes focus but not selection; focus wraps", async () => {
      await userEvent.keyboard("{ArrowRight}");
      await expect(sync).toHaveFocus();
      await userEvent.keyboard("{ArrowRight}");
      await expect(billing).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await expect(billing).toHaveAttribute("aria-selected", "false");
      await userEvent.keyboard("{ArrowRight}");
      await expect(general).toHaveFocus();
      await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
      await expect(sync).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await expect(sync).toHaveAttribute("aria-selected", "true");
    });

    await step("Tab moves into the selected panel", async () => {
      await userEvent.tab();
      await expect(canvas.getByRole("tabpanel", { name: "Sync" })).toHaveFocus();
    });
  },
};
