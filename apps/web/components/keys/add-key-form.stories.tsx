import type { Meta, StoryObj } from "@storybook/react-vite";
import { useId } from "react";
import { expect, fn } from "storybook/test";
import { AddKeyForm, type AddKeyOutcome, type ProviderOption } from "./add-key-form";

const PROVIDERS: ProviderOption[] = [
  { id: "openai", name: "OpenAI", use: "models and speech" },
  { id: "anthropic", name: "Anthropic", use: "language models" },
  { id: "deepgram", name: "Deepgram", use: "speech-to-text" },
];

/** Not a real key. */
const KEY = "sk-proj-STORYcanaryNotARealKeyQz7Xw2Lp9abcd";

const accepted = async (): Promise<AddKeyOutcome> => ({
  ok: true,
  message: "Saved on this device: your OpenAI key ending in abcd.",
});

const meta = {
  title: "Web/Keys/AddKeyForm",
  component: AddKeyForm,
  parameters: { layout: "padded" },
  args: {
    providers: PROVIDERS,
    submitLabel: "Check and save",
    replaceLabel: "Check and replace",
    workingLabel: (name: string) => `Checking the key with ${name}…`,
    keyHint: (name: string) =>
      `Earshot checks it with ${name} once, then encrypts it in this browser. It isn't shown again.`,
    onSubmit: fn(accepted),
  },
} satisfies Meta<typeof AddKeyForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    const key = canvas.getByLabelText("Key");
    await expect(key).toHaveAttribute("type", "password");
    await expect(key).toHaveAttribute("autocomplete", "off");
    await expect(key).toHaveAccessibleDescription(/encrypts it in this browser/);
    await expect(canvas.getByLabelText("Label")).toHaveValue("default");
  },
};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

/** The key goes to the handler once, and the field is empty again before the check finishes. */
export const SubmitsAndClearsTheKey: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.selectOptions(canvas.getByLabelText("Provider"), "deepgram");
    await expect(canvas.getByLabelText("Key")).toHaveAccessibleDescription(/with Deepgram/);
    await userEvent.selectOptions(canvas.getByLabelText("Provider"), "openai");
    await userEvent.clear(canvas.getByLabelText("Label"));
    await userEvent.type(canvas.getByLabelText("Label"), "work");
    await userEvent.type(canvas.getByLabelText("Key"), KEY);
    await userEvent.click(canvas.getByRole("button", { name: "Check and save" }));

    await expect(args.onSubmit).toHaveBeenCalledWith(
      { provider: "openai", label: "work", key: KEY },
      expect.any(FormData),
    );
    await expect(canvas.getByLabelText("Key")).toHaveValue("");
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      "Saved on this device: your OpenAI key ending in abcd.",
    );
    await expect(canvas.getByLabelText("Label")).toHaveValue("default");
  },
};

/** A refusal is announced, the field is cleared anyway, and focus returns to it. */
export const ShowsAProblem: Story = {
  args: {
    onSubmit: fn(
      async (): Promise<AddKeyOutcome> => ({
        ok: false,
        message:
          "OpenAI rejected this key. Check that you copied all of it and that it hasn't been revoked.",
      }),
    ),
  },
  play: async ({ canvas, userEvent }) => {
    await userEvent.type(canvas.getByLabelText("Key"), KEY);
    await userEvent.click(canvas.getByRole("button", { name: "Check and save" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("OpenAI rejected this key.");
    await expect(canvas.getByLabelText("Key")).toHaveValue("");
    await expect(canvas.getByLabelText("Key")).toHaveFocus();
  },
};

export const ShowsAProblemDark: Story = {
  ...ShowsAProblem,
  name: "Shows a problem (dark)",
  globals: { theme: "dark" },
};

/** Nothing is sent without a key, or with a label shaped like one, which is cleared too. */
export const RefusesBadInput: Story = {
  play: async ({ args, canvas, userEvent, step }) => {
    await step("No key", async () => {
      await userEvent.click(canvas.getByRole("button", { name: "Check and save" }));
      await expect(await canvas.findByRole("alert")).toHaveTextContent("Paste a key first.");
      await expect(canvas.getByLabelText("Key")).toHaveFocus();
    });

    await step("A key pasted into the label", async () => {
      await userEvent.clear(canvas.getByLabelText("Label"));
      await userEvent.type(
        canvas.getByLabelText("Label"),
        "sk-proj-abcdefghijklmnopqrstuvwxyz0123",
      );
      await userEvent.type(canvas.getByLabelText("Key"), KEY);
      await userEvent.click(canvas.getByRole("button", { name: "Check and save" }));
      await expect(await canvas.findByRole("alert")).toHaveTextContent("don't put a key in it");
      await expect(canvas.getByLabelText("Label")).toHaveValue("");
      await expect(canvas.getByLabelText("Key")).toHaveValue("");
    });

    await expect(args.onSubmit).not.toHaveBeenCalled();
  },
};

/** Naming a slot that already holds a key says so on the button. */
export const ReplacingAKey: Story = {
  args: { existing: [{ provider: "openai", label: "work" }] },
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByRole("button", { name: "Check and save" })).toBeVisible();
    await userEvent.clear(canvas.getByLabelText("Label"));
    await userEvent.type(canvas.getByLabelText("Label"), "work");
    await expect(canvas.getByRole("button", { name: "Check and replace" })).toBeVisible();
    await userEvent.selectOptions(canvas.getByLabelText("Provider"), "anthropic");
    await expect(canvas.getByRole("button", { name: "Check and save" })).toBeVisible();
  },
};

function AlsoOnDevice() {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        name="also-on-device"
        type="checkbox"
        className="mt-0.5 size-4 accent-primary"
      />
      <label htmlFor={id} className="text-sm">
        Also keep a copy on this device
      </label>
    </div>
  );
}

/** The vault's version: extra fields reach the handler through the form's data. */
export const ForTheVault: Story = {
  args: {
    submitLabel: "Check and store on the server",
    replaceLabel: "Check and replace on the server",
    keyHint: (name: string) =>
      `Earshot checks it with ${name}, then stores it encrypted on the server. It isn't shown again.`,
    extraFields: <AlsoOnDevice />,
  },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByLabelText("Also keep a copy on this device"));
    await userEvent.type(canvas.getByLabelText("Key"), KEY);
    await userEvent.click(canvas.getByRole("button", { name: "Check and store on the server" }));
    const form = (args.onSubmit as ReturnType<typeof fn>).mock.calls[0]?.[1] as FormData;
    await expect(form.get("also-on-device")).toBe("on");
    // The key never travels in the form's data.
    await expect([...form.values()]).not.toContain(KEY);
  },
};

export const ForTheVaultDark: Story = {
  ...ForTheVault,
  name: "For the vault (dark)",
  globals: { theme: "dark" },
  play: undefined,
};
