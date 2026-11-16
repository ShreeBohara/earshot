import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, waitFor } from "storybook/test";
import { KeyList, type KeyListItem } from "./key-list";

const ITEMS: KeyListItem[] = [
  {
    id: "openai:work",
    providerName: "OpenAI",
    label: "work",
    last4: "s5Hg",
    meta: "Added Nov 15, 2026 · last passed a check 3 minutes ago",
    status: { kind: "checked", at: "2026-11-15T12:00:00Z" },
  },
  {
    id: "deepgram:default",
    providerName: "Deepgram",
    label: "default",
    last4: "c4b6",
    meta: "Added Nov 14, 2026",
    status: { kind: "unchecked" },
  },
  {
    id: "gemini:personal",
    providerName: "Google Gemini",
    label: "personal",
    last4: "9QxA",
    meta: "Added Nov 13, 2026",
    status: { kind: "checking" },
  },
  {
    id: "anthropic:default",
    providerName: "Anthropic",
    label: "default",
    last4: "Pq2x",
    meta: "Added Nov 12, 2026 · last passed a check 3 days ago",
    status: { kind: "problem", problem: "rejected" },
  },
  {
    id: "groq:default",
    providerName: "Groq",
    label: "default",
    last4: "Lm7e",
    meta: "Added Nov 10, 2026 · last passed a check 5 days ago",
    status: { kind: "problem", problem: "too_many_requests", retryAfterSeconds: 420 },
  },
];

const meta = {
  title: "Web/Keys/KeyList",
  component: KeyList,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
  args: {
    items: ITEMS,
    label: "Keys on this device",
    empty: "No keys on this device yet. Add one below.",
    onCheck: fn(),
    onRemove: fn(),
  },
} satisfies Meta<typeof KeyList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every status a key can show: one pill each, with a word and a shape as well as a color. */
export const Statuses: Story = {
  play: async ({ canvas }) => {
    const list = canvas.getByRole("list", { name: "Keys on this device" });
    await expect(list.querySelectorAll("li")).toHaveLength(ITEMS.length);
    for (const word of ["Checked", "Not checked", "Checking…", "Rejected"]) {
      await expect(canvas.getAllByText(word, { exact: true }).length).toBeGreaterThan(0);
    }
    await expect(canvas.getByText(/Anthropic rejected this key/)).toBeVisible();
    await expect(canvas.getByText(/Try again in 7 minutes/)).toBeVisible();
    // Only the last four characters, read out as such.
    await expect(list).toHaveTextContent("ending in ••••s5Hg");
    // A key being checked can't be checked twice at once.
    await expect(
      canvas.getByRole("button", { name: "Check again: Google Gemini key “personal”" }),
    ).toBeDisabled();
  },
};

export const StatusesDark: Story = {
  ...Statuses,
  name: "Statuses (dark)",
  globals: { theme: "dark" },
};

export const Empty: Story = {
  args: { items: [] },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("No keys on this device yet. Add one below.")).toBeVisible();
    await expect(canvas.queryByRole("list")).not.toBeInTheDocument();
  },
};

/** Removing asks first, moves focus to the confirmation, and cancels from the keyboard. */
export const RemoveWithConfirmation: Story = {
  play: async ({ args, canvas, userEvent, step }) => {
    await step("Cancel leaves the key alone", async () => {
      await userEvent.click(canvas.getByRole("button", { name: "Remove the OpenAI key “work”" }));
      await expect(
        canvas.getByRole("button", { name: "Yes, remove the OpenAI key “work”" }),
      ).toHaveFocus();
      await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
      await expect(args.onRemove).not.toHaveBeenCalled();
    });

    await step("Confirming removes it", async () => {
      await userEvent.click(canvas.getByRole("button", { name: "Remove the OpenAI key “work”" }));
      await userEvent.keyboard("{Enter}");
      await expect(args.onRemove).toHaveBeenCalledWith(
        expect.objectContaining({ id: "openai:work" }),
      );
    });
  },
};

function OneKey() {
  const [items, setItems] = useState(ITEMS.slice(0, 1));
  return (
    <KeyList
      items={items}
      label="Keys on this device"
      empty="No keys on this device yet. Add one below."
      onRemove={(removed) => setItems((current) => current.filter((i) => i.id !== removed.id))}
    />
  );
}

/** Removing the last key leaves focus on the note that replaces the list, not on the page. */
export const RemovingTheLastKey: Story = {
  render: () => <OneKey />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Remove the OpenAI key “work”" }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Yes, remove the OpenAI key “work”" }),
    );
    await waitFor(() =>
      expect(canvas.getByText("No keys on this device yet. Add one below.")).toHaveFocus(),
    );
  },
};

export const CheckAgain: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(
      canvas.getByRole("button", { name: "Check again: Deepgram key “default”" }),
    );
    await expect(args.onCheck).toHaveBeenCalledWith(
      expect.objectContaining({ id: "deepgram:default" }),
    );
  },
};

/** Keys in the server vault: metadata and remove, no checking from here. */
export const VaultKeys: Story = {
  args: {
    label: "Keys stored on the server",
    empty: "No keys stored on the server.",
    onCheck: undefined,
    items: [
      {
        id: "openai:shared",
        providerName: "OpenAI",
        label: "shared",
        last4: "wxyz",
        meta: "Stored Nov 15, 2026 · last passed a check 2 hours ago",
        status: { kind: "checked", at: "2026-11-15T10:00:00Z" },
      },
    ],
  },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("button", { name: /Check again/ })).not.toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Remove the OpenAI key “shared”" }),
    ).toBeVisible();
  },
};
