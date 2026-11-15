import { Input } from "@earshot/ui/components/input";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

const meta = {
  title: "Components/Input",
  component: Input,
  args: { "aria-label": "Deal name", placeholder: "Acme renewal" },
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Typing works, and focus shows the ring. */
export const Playground: Story = {
  play: async ({ canvas, userEvent }) => {
    const input = canvas.getByRole("textbox", { name: "Deal name" });
    await userEvent.tab();
    await expect(input).toHaveFocus();
    await userEvent.type(input, "Acme renewal, 2027");
    await expect(input).toHaveValue("Acme renewal, 2027");
  },
};

/** Empty, filled, invalid, disabled, and file. Labeled with aria-label; see Field for labels. */
export const States: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Input aria-label="Empty" placeholder="Placeholder" />
      <Input aria-label="Filled" defaultValue="Acme Corp" />
      <Input aria-label="Invalid" aria-invalid defaultValue="not-a-key" />
      <Input aria-label="Disabled" disabled defaultValue="Read only" />
      <Input aria-label="Transcript file" type="file" />
    </div>
  ),
};

export const StatesDark: Story = {
  ...States,
  name: "States (dark)",
  globals: { theme: "dark" },
};
