import { RadioGroup, RadioGroupItem } from "@earshot/ui/components/radio-group";
import { bothThemes, bothThemesParameters, themePanel } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useId, useState } from "react";
import { expect, userEvent, within } from "storybook/test";

function RecordChoice() {
  const id = useId();
  const [value, setValue] = useState<string | null>(null);
  return (
    <div className="grid w-72 gap-2">
      <p id={id} className="font-medium text-sm">
        Which record?
      </p>
      <RadioGroup
        aria-labelledby={id}
        value={value}
        onValueChange={(next) => setValue(String(next))}
      >
        {["Dana Lee, Acme Corp", "Dana Li, Akme Dynamics", "A new record"].map((label) => (
          <label key={label} className="flex min-h-8 items-center gap-2 text-sm">
            <RadioGroupItem value={label} />
            {label}
          </label>
        ))}
      </RadioGroup>
    </div>
  );
}

const meta = {
  title: "Components/RadioGroup",
  component: RecordChoice,
  decorators: [bothThemes],
  parameters: { ...bothThemesParameters, layout: "padded" },
} satisfies Meta<typeof RecordChoice>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One tab stop; the arrow keys move and select; each radio named by its label. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const group = panel.getByRole("radiogroup", { name: "Which record?" });
    const [first, second] = within(group).getAllByRole("radio");
    await expect(first).not.toBeChecked();
    await userEvent.click(panel.getByText("Dana Lee, Acme Corp"));
    await expect(first).toBeChecked();
    await userEvent.keyboard("{ArrowDown}");
    await expect(second).toBeChecked();
  },
};
