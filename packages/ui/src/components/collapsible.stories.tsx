import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@earshot/ui/components/collapsible";
import { bothThemes, bothThemesParameters, themePanel } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChevronRightIcon } from "lucide-react";
import { expect, userEvent, within } from "storybook/test";

function LensDisclosure() {
  return (
    <Collapsible>
      <CollapsibleTrigger className="font-medium text-sm">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-4 transition-transform group-data-[panel-open]/collapsible:rotate-90 motion-reduce:transition-none"
        />
        MEDDIC: 2 of 6 mentioned
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <dl className="mt-2 grid gap-1 text-sm">
          <dt className="font-medium">Identified pain</dt>
          <dd className="text-muted-foreground">“onboarding took longer than they hoped”</dd>
          <dt className="font-medium">Champion</dt>
          <dd className="text-muted-foreground">Not mentioned</dd>
        </dl>
      </CollapsiblePanel>
    </Collapsible>
  );
}

const meta = {
  title: "Components/Collapsible",
  component: LensDisclosure,
  decorators: [bothThemes],
  parameters: { ...bothThemesParameters, layout: "padded" },
} satisfies Meta<typeof LensDisclosure>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Collapsed: a button with aria-expanded, its panel hidden until Enter, Space, or a click. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const trigger = panel.getByRole("button", { name: "MEDDIC: 2 of 6 mentioned" });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(panel.queryByText("Identified pain")).toBeNull();
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(panel.getByText("Identified pain")).toBeVisible();
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  },
};
