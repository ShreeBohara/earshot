import { Button } from "@earshot/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@earshot/ui/components/dropdown-menu";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { LogOutIcon, SettingsIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { expect, screen, waitFor } from "storybook/test";

const meta = {
  title: "Components/DropdownMenu",
  component: DropdownMenu,
} satisfies Meta<typeof DropdownMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The app header's account menu: who's signed in, then Settings and Sign out. */
function AccountMenu(props: ComponentProps<typeof DropdownMenu>) {
  return (
    <DropdownMenu {...props}>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="icon" />}
        aria-label="Account menu for Ada Archer"
      >
        AA
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <span className="block font-medium text-foreground">Ada Archer</span>
            <span className="block">ada@example.com</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem href="#settings">
          <SettingsIcon aria-hidden="true" />
          Settings
        </DropdownMenuLinkItem>
        <DropdownMenuItem>
          <LogOutIcon aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const Open: Story = {
  args: { defaultOpen: true },
  parameters: { layout: "padded" },
  render: (args) => (
    <div className="flex min-h-64 justify-end">
      <AccountMenu {...args} />
    </div>
  ),
};

export const OpenDark: Story = {
  ...Open,
  name: "Open (dark)",
  globals: { theme: "dark" },
};

/** Enter opens it, arrow keys move between items, Escape closes it and returns focus. */
export const KeyboardNavigation: Story = {
  render: (args) => <AccountMenu {...args} />,
  play: async ({ canvas, userEvent, step }) => {
    const trigger = canvas.getByRole("button", { name: "Account menu for Ada Archer" });

    await step("Enter opens the menu on its first item", async () => {
      await userEvent.tab();
      await expect(trigger).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(screen.getByRole("menu")).toBeVisible());
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveAttribute(
          "data-highlighted",
        ),
      );
    });

    await step("Arrow keys move between the items", async () => {
      await userEvent.keyboard("{ArrowDown}");
      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: "Sign out" })).toHaveAttribute(
          "data-highlighted",
        ),
      );
      await userEvent.keyboard("{ArrowUp}");
      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveAttribute(
          "data-highlighted",
        ),
      );
    });

    await step("Escape closes it and focus returns to the trigger", async () => {
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
      await expect(trigger).toHaveFocus();
    });
  },
};
