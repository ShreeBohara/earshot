import { Button } from "@earshot/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@earshot/ui/components/dialog";
import { Field, FieldDescription, FieldLabel } from "@earshot/ui/components/field";
import { Input } from "@earshot/ui/components/input";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, waitFor } from "storybook/test";

const meta = {
  title: "Components/Dialog",
  component: Dialog,
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

function KeyDialogContent() {
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Add your OpenAI key</DialogTitle>
        <DialogDescription>
          Earshot keeps it on this device and calls OpenAI directly.
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel>API key</FieldLabel>
        <Input placeholder="sk-…" />
        <FieldDescription>You can remove it at any time in Settings.</FieldDescription>
      </Field>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button>Save key</Button>
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * Open from the start. There's no trigger on the page: a modal dialog hides everything behind
 * it from assistive tech, and axe would flag a focusable trigger inside that hidden content.
 */
export const Open: Story = {
  args: { defaultOpen: true },
  render: (args) => (
    <Dialog {...args}>
      <KeyDialogContent />
    </Dialog>
  ),
};

export const OpenDark: Story = {
  ...Open,
  name: "Open (dark)",
  globals: { theme: "dark" },
};

/** Enter opens it and moves focus inside; Escape closes it and returns focus to the trigger. */
export const KeyboardOpenAndClose: Story = {
  render: (args) => (
    <Dialog {...args}>
      <DialogTrigger render={<Button variant="outline" />}>Add API key</DialogTrigger>
      <KeyDialogContent />
    </Dialog>
  ),
  play: async ({ canvas, userEvent, step }) => {
    const trigger = canvas.getByRole("button", { name: "Add API key" });

    await step("Enter opens the dialog and moves focus into it", async () => {
      await userEvent.tab();
      await expect(trigger).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      const dialog = await screen.findByRole("dialog", { name: "Add your OpenAI key" });
      await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    });

    await step("Escape closes it and focus returns to the trigger", async () => {
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await expect(trigger).toHaveFocus();
    });
  },
};
