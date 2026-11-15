import { Button } from "@earshot/ui/components/button";
import { Toaster, toast } from "@earshot/ui/components/toast";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, waitFor } from "storybook/test";

const meta = {
  title: "Components/Toast",
  component: Toaster,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      // Five, not the default three, so the gallery can show every type at once.
      <Toaster limit={5}>
        <div className="flex min-h-80 items-start justify-center p-6">
          <Story />
        </div>
      </Toaster>
    ),
  ],
} satisfies Meta<typeof Toaster>;

export default meta;
type Story = StoryObj<typeof meta>;

function showToastTypes() {
  // timeout 0: they stay until dismissed.
  toast.add({ type: "info", title: "Transcript ready", timeout: 0 });
  toast.add({ type: "loading", title: "Syncing to HubSpot…", timeout: 0 });
  toast.add({
    type: "error",
    title: "Sync failed",
    description: "HubSpot rate-limited the request. Nothing was written.",
    timeout: 0,
    actionProps: { children: "Retry" },
  });
  toast.add({
    type: "warning",
    title: "1 field needs review",
    description: "The amount changed in HubSpot since the call.",
    timeout: 0,
  });
  toast.add({
    type: "success",
    title: "Synced 3 fields to HubSpot",
    description: "Acme renewal · amount, close date, next step",
    timeout: 0,
    actionProps: { children: "Undo" },
  });
}

/** Every type: success (synced), warning (conflict), error (failed), info, and loading. */
export const Types: Story = {
  render: () => (
    <Button variant="outline" onClick={showToastTypes}>
      Show the toast types
    </Button>
  ),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Show the toast types" }));
    const front = await screen.findByText("Synced 3 fields to HubSpot");
    await userEvent.hover(front);
    // The stack takes up to 500ms to expand; allow for a slow runner.
    await waitFor(() => expect(screen.getByText("Sync failed")).toBeVisible(), { timeout: 3000 });
    // Let the stack finish expanding, so a visual snapshot doesn't catch it mid-transition.
    // (The loading spinner never finishes, so infinite animations don't count.)
    const settling = () =>
      document
        .getAnimations()
        .filter(
          (a) => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity,
        );
    await waitFor(() => expect(settling()).toHaveLength(0), { timeout: 3000 });
  },
};

export const TypesDark: Story = {
  ...Types,
  name: "Types (dark)",
  globals: { theme: "dark" },
};

function SyncButton() {
  return (
    <Button
      onClick={() => {
        const id = toast.add({
          type: "success",
          title: "Synced 3 fields to HubSpot",
          actionProps: {
            children: "Undo",
            onClick: () => {
              toast.close(id);
              toast.add({ title: "Sync undone", description: "HubSpot is back to how it was." });
            },
          },
        });
      }}
    >
      Sync to HubSpot
    </Button>
  );
}

/** A sync result with an Undo action. */
export const SyncAndUndo: Story = {
  render: () => <SyncButton />,
  play: async ({ canvas, userEvent, step }) => {
    await step("Syncing (from the keyboard) shows the result", async () => {
      await userEvent.tab();
      await expect(canvas.getByRole("button", { name: "Sync to HubSpot" })).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await expect(await screen.findByText("Synced 3 fields to HubSpot")).toBeVisible();
    });

    await step("Undo replaces it with a confirmation", async () => {
      await userEvent.click(screen.getByRole("button", { name: "Undo" }));
      await expect(await screen.findByText("Sync undone")).toBeVisible();
      await waitFor(() =>
        expect(screen.queryByText("Synced 3 fields to HubSpot")).not.toBeInTheDocument(),
      );
    });
  },
};
