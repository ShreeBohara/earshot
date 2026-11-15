import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@earshot/ui/components/field";
import { Input } from "@earshot/ui/components/input";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect } from "storybook/test";

const meta = {
  title: "Components/Field",
  component: Field,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Label, description, and error, linked to the input for assistive tech. */
export const Variants: Story = {
  render: () => (
    <FieldGroup>
      <Field>
        <FieldLabel>Workspace name</FieldLabel>
        <Input defaultValue="Acme sales" />
      </Field>
      <Field>
        <FieldLabel>CRM owner email</FieldLabel>
        <Input type="email" placeholder="you@company.com" />
        <FieldDescription>We only use it to match deals to you.</FieldDescription>
      </Field>
      <Field invalid>
        <FieldLabel>OpenAI API key</FieldLabel>
        <Input defaultValue="pk-live-1234" />
        <FieldDescription>
          Stays on this device. Earshot never sends it to a server.
        </FieldDescription>
        <FieldError>Keys start with “sk-”.</FieldError>
      </Field>
      <Field disabled>
        <FieldLabel>Region</FieldLabel>
        <Input defaultValue="us-east" />
        <FieldDescription>Set by your admin.</FieldDescription>
      </Field>
      <FieldSeparator>Sync</FieldSeparator>
      <FieldSet>
        <FieldLegend variant="label">Write-back</FieldLegend>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel>Approval threshold</FieldLabel>
            <FieldDescription>Changes above this amount need a second look.</FieldDescription>
          </FieldContent>
          <Input className="w-28" defaultValue="$10,000" />
        </Field>
      </FieldSet>
    </FieldGroup>
  ),
};

export const VariantsDark: Story = {
  ...Variants,
  name: "Variants (dark)",
  globals: { theme: "dark" },
};

function ApiKeyField() {
  const [value, setValue] = useState("");
  const invalid = value.length > 0 && !value.startsWith("sk-");

  return (
    <Field invalid={invalid}>
      <FieldLabel>OpenAI API key</FieldLabel>
      <Input value={value} onChange={(event) => setValue(event.target.value)} />
      <FieldDescription>Stays on this device.</FieldDescription>
      {invalid && <FieldError>Keys start with “sk-”.</FieldError>}
    </Field>
  );
}

/** The error appears, is announced, and joins the input's description; fixing it clears it. */
export const Validation: Story = {
  render: () => <ApiKeyField />,
  play: async ({ canvas, userEvent, step }) => {
    const input = canvas.getByRole("textbox", { name: "OpenAI API key" });
    await expect(input).toHaveAccessibleDescription("Stays on this device.");

    await step("An invalid key shows the error", async () => {
      await userEvent.type(input, "pk-123");
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await expect(canvas.getByRole("alert")).toHaveTextContent("Keys start with “sk-”.");
      await expect(input).toHaveAccessibleDescription(/Keys start with/);
    });

    await step("A valid key clears it", async () => {
      await userEvent.clear(input);
      await userEvent.type(input, "sk-123");
      await expect(input).not.toHaveAttribute("aria-invalid");
      await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
    });
  },
};
