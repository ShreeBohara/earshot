import { Toaster } from "@earshot/ui/components/toast";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import type { ReviewSink } from "@/lib/inbox/sinks";
import { EMPTY_INBOX, INBOX, PLAIN, QUESTION, UPDATE } from "./fixtures";
import { InboxView } from "./inbox-view";

/** A sink that records what the inbox sends and answers yes. */
const sent: Parameters<ReviewSink["send"]>[] = [];
const sink: ReviewSink = {
  send: async (...args) => {
    sent.push(args);
    return { ok: true };
  },
};

/** A sink that refuses everything as stale, as the route does for a card that changed. */
const refusing: ReviewSink = { send: async () => ({ ok: false, reason: "stale" }) };

const meta = {
  title: "Web/Inbox/InboxView",
  component: InboxView,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <Toaster>
        <div className="mx-auto w-full max-w-3xl pb-40">
          <Story />
        </div>
      </Toaster>
    ),
  ],
  args: { initial: INBOX, sink, reload: async () => null },
} satisfies Meta<typeof InboxView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A new workspace: nothing to review, and where the sample debriefs are. */
export const Empty: Story = {
  args: { initial: EMPTY_INBOX },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { name: "Nothing to review yet" })).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Settings → Data" })).toBeVisible();
  },
};

export const EmptyDark: Story = { ...Empty, name: "Empty (dark)", globals: { theme: "dark" } };

/**
 * The inbox: a debrief's cards in a list labelled by its account and time, one card in the tab
 * order, then Finishing, Reviewed (with Undo), and Snoozed.
 */
export const Inbox: Story = {
  play: async ({ canvas }) => {
    const list = canvas.getByRole("list", { name: /^Acme Corp · / });
    await expect(within(list).getAllByRole("article")).toHaveLength(4);
    const cards = canvas.getAllByRole("article");
    await expect(cards[0]).toHaveAttribute("tabindex", "0");
    await expect(cards[1]).toHaveAttribute("tabindex", "-1");
    await expect(canvas.getByRole("region", { name: "Finishing" })).toHaveTextContent(
      /Finishing, usually under a minute/,
    );
    await expect(
      canvas.getByRole("button", { name: "Undo: accepted, task for Sean Murphy" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Review now: note for Acme Corp" }),
    ).toBeVisible();
  },
};

export const InboxDark: Story = { ...Inbox, name: "Inbox (dark)", globals: { theme: "dark" } };

/**
 * The keys, in the list: j moves, a accepts and focus moves to the next card, one polite message
 * says so, u brings the card back and focuses it, and 2 on the question chooses its second record.
 */
export const Keyboard: Story = {
  play: async ({ canvas }) => {
    sent.length = 0;
    const card = (name: string | RegExp) => canvas.getByRole("article", { name });
    card(/^Contact · Ask/).focus();
    await userEvent.keyboard("j");
    await expect(card("Deal update · Acme Corp - Platform")).toHaveFocus();
    await userEvent.keyboard("a");
    await waitFor(() =>
      expect(
        canvas.queryByRole("article", { name: "Deal update · Acme Corp - Platform" }),
      ).toBeNull(),
    );
    await expect(card("Task · Sean Murphy")).toHaveFocus();
    await expect(
      await screen.findByText(
        "Accepted: deal update for Acme Corp - Platform. 3 left. Press U to undo.",
      ),
    ).toBeVisible();
    await waitFor(() => expect(sent).toHaveLength(1));
    const [sessionId, request] = sent[0] ?? [];
    await expect(sessionId).toBe(INBOX.sessions[1]?.sessionId);
    await expect(request?.reviews[0]).toMatchObject({
      proposalId: UPDATE.proposalId,
      decision: "approved",
      mode: "single",
      input: "keyboard",
      surface: "inbox",
      seen: {
        tier: "none",
        fields: { stage: { proposed: "proposal", base: "presentationscheduled" } },
      },
    });

    await userEvent.keyboard("u");
    await waitFor(() => expect(card("Deal update · Acme Corp - Platform")).toHaveFocus());
    await waitFor(() => expect(sent).toHaveLength(2));
    await expect(sent[1]?.[1].reviews[0]).toMatchObject({ decision: "reopened", reason: "undo" });

    await userEvent.keyboard("k");
    await expect(card(/^Contact · Ask/)).toHaveFocus();
    await userEvent.keyboard("2");
    await waitFor(() => expect(sent).toHaveLength(3));
    await expect(sent[2]?.[1].reviews[0]).toMatchObject({
      proposalId: QUESTION.proposalId,
      target: { entityId: QUESTION.target.candidates[1]?.entityId },
    });
    await expect(card("Deal update · Acme Corp - Platform")).toHaveFocus();
  },
};

/**
 * A refusal brings the card back, with one urgent message. Base UI 1.9 announces an urgent toast
 * through its own visually hidden role="alert" copy, and hides the visible toast from assistive
 * tech (aria-hidden) until focus enters the region, though it stays focusable; axe's
 * aria-hidden-focus rule flags that pairing, so it's off for this story alone (ADR-0035).
 */
export const Refused: Story = {
  args: { sink: refusing },
  parameters: {
    a11y: {
      test: "error",
      config: {
        rules: [
          { id: "target-size", enabled: true },
          { id: "aria-hidden-focus", enabled: false },
        ],
      },
    },
  },
  play: async ({ canvas }) => {
    const plain = () => canvas.queryByRole("article", { name: "Task · Sean Murphy" });
    plain()?.focus();
    await userEvent.keyboard("r");
    // Shown in the toast, and repeated in Base UI's urgent (role="alert") copy.
    const messages = await screen.findAllByText(
      /Couldn't record your review of the task for Sean Murphy/,
    );
    await expect(messages.length).toBeGreaterThan(0);
    await waitFor(() => expect(plain()).not.toBeNull());
  },
};

/** The shortcuts dialog: the keys, and NVDA's focus mode. */
export const ShortcutsDialog: Story = {
  play: async ({ canvas }) => {
    canvas.getAllByRole("article")[0]?.focus();
    await userEvent.keyboard("?");
    const dialog = await screen.findByRole("dialog", { name: "Inbox keyboard shortcuts" });
    await expect(within(dialog).getByText(/NVDA\+Space/)).toBeVisible();
  },
};

export const ShortcutsDialogDark: Story = {
  ...ShortcutsDialog,
  name: "Shortcuts dialog (dark)",
  globals: { theme: "dark" },
};

/**
 * "Accept all from this call" (spec WP6): the debrief's header says "Accept 2 unmarked", and the
 * checkpoint opens inline, under it: what will be accepted, what stays for review and why, and
 * focus on its confirm button, which its summary describes. axe runs on it open.
 */
export const AcceptAll: Story = {
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Accept 2 unmarked" }));
    const checkpoint = canvas.getByRole("group", { name: "Accept all from this call" });
    const confirm = within(checkpoint).getByRole("button", { name: "Accept 2" });
    await expect(confirm).toHaveFocus();
    await expect(confirm).toHaveAccessibleDescription("2 will be accepted. 2 stay for review.");
    const accepts = within(checkpoint).getByRole("list", { name: "Will be accepted (2)" });
    await expect(within(accepts).getAllByRole("listitem")).toHaveLength(2);
    const stays = within(checkpoint).getByRole("list", { name: "Stays for review (2)" });
    await expect(stays).toHaveTextContent(/Needs a check: I'm not sure who you meant\./);
    await expect(stays).toHaveTextContent(/Has a note: Open account assumed/);
  },
};

export const AcceptAllDark: Story = {
  ...AcceptAll,
  name: "Accept all (dark)",
  globals: { theme: "dark" },
};

/**
 * Confirming: the two leave as one batch (one request, one batch id), focus goes to the first card
 * left in the group, one polite message says so, and one u brings both back, focused on the first.
 */
export const AcceptAllConfirmed: Story = {
  play: async ({ canvas }) => {
    sent.length = 0;
    await userEvent.click(canvas.getByRole("button", { name: "Accept 2 unmarked" }));
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(sent).toHaveLength(1));
    const [, request] = sent[0] ?? [];
    await expect(request?.reviews.map((review) => review.proposalId)).toEqual([
      UPDATE.proposalId,
      PLAIN.proposalId,
    ]);
    await expect(new Set(request?.reviews.map((review) => review.batchId)).size).toBe(1);
    await expect(request?.reviews[0]).toMatchObject({ mode: "batch", input: "keyboard" });
    await expect(
      await screen.findByText("Accepted 2. 2 stay for review. Press U to undo."),
    ).toBeVisible();
    await expect(canvas.getByRole("article", { name: /^Contact · Ask/ })).toHaveFocus();
    await expect(
      canvas.getByRole("button", { name: "Undo: accepted together, 2 proposals" }),
    ).toBeVisible();
    await userEvent.keyboard("u");
    await waitFor(() =>
      expect(
        canvas.getByRole("article", { name: "Deal update · Acme Corp - Platform" }),
      ).toHaveFocus(),
    );
    await waitFor(() => expect(sent).toHaveLength(2));
    await expect(sent[1]?.[1].reviews.map((review) => review.decision)).toEqual([
      "reopened",
      "reopened",
    ]);
  },
};
