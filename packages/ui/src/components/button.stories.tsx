import { Button } from "@earshot/ui/components/button";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowRightIcon, CheckIcon, PlusIcon } from "lucide-react";
import { expect, fn, waitFor } from "storybook/test";

const VARIANTS = ["default", "outline", "secondary", "ghost", "destructive", "link"] as const;
const SIZES = ["xs", "sm", "default", "lg"] as const;
const ICON_SIZES = ["icon-xs", "icon-sm", "icon", "icon-lg"] as const;

const meta = {
  title: "Components/Button",
  component: Button,
  args: { children: "Approve", onClick: fn() },
  argTypes: {
    variant: { control: "select", options: VARIANTS },
    size: { control: "select", options: [...SIZES, ...ICON_SIZES] },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Enter and Space both activate it, like a native button. */
export const Playground: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const button = canvas.getByRole("button", { name: "Approve" });
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    await expect(args.onClick).toHaveBeenCalledTimes(2);
  },
};

/** Every variant at every size, with icons, icon-only, and disabled. */
export const Variants: Story = {
  parameters: { layout: "padded" },
  render: (args) => (
    <div className="flex flex-col gap-4">
      {VARIANTS.map((variant) => (
        <div key={variant} className="flex flex-wrap items-center gap-3">
          {SIZES.map((size) => (
            <Button key={size} {...args} variant={variant} size={size}>
              {variant} · {size}
            </Button>
          ))}
          <Button {...args} variant={variant}>
            <CheckIcon data-icon="inline-start" aria-hidden="true" />
            Approve
          </Button>
          <Button {...args} variant={variant}>
            Next
            <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
          </Button>
          {ICON_SIZES.map((size) => (
            <Button key={size} {...args} variant={variant} size={size} aria-label="Add a note">
              <PlusIcon aria-hidden="true" />
            </Button>
          ))}
          <Button {...args} variant={variant} disabled>
            Disabled
          </Button>
        </div>
      ))}
    </div>
  ),
};

export const VariantsDark: Story = {
  ...Variants,
  name: "Variants (dark)",
  globals: { theme: "dark" },
};

/** The keyboard focus ring: 2px, offset from the button, at least 3:1 on the page. */
export const FocusRing: Story = {
  render: (args) => (
    <div className="flex items-center gap-3">
      <Button {...args}>Approve</Button>
      <Button {...args} variant="outline">
        Edit
      </Button>
      <Button {...args} variant="ghost" size="icon-xs" aria-label="Add a note">
        <PlusIcon aria-hidden="true" />
      </Button>
    </div>
  ),
  play: async ({ canvas, userEvent }) => {
    const edit = canvas.getByRole("button", { name: "Edit" });
    await userEvent.tab();
    await userEvent.tab();
    await expect(edit).toHaveFocus();
    await expect(edit.matches(":focus-visible")).toBe(true);
    // The ring transitions in (except with reduced motion), so wait for it to settle.
    await waitFor(() =>
      expect(edit).toHaveStyle({
        outlineStyle: "solid",
        outlineWidth: "2px",
        outlineOffset: "2px",
      }),
    );
  },
};

export const FocusRingDark: Story = {
  ...FocusRing,
  name: "Focus ring (dark)",
  globals: { theme: "dark" },
};
