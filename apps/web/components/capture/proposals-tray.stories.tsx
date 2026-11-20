import { bothThemes, bothThemesParameters, themePanel } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { ReviewWriter } from "@/lib/inbox/sinks";
import { demoState, ENTITIES, PROPOSALS, QUOTES, SESSION_ID, WITNESS_CONFLICT } from "./fixtures";
import { ProposalsTray } from "./proposals-tray";

const meta = {
  title: "Web/Capture/ProposalsTray",
  component: ProposalsTray,
  decorators: [bothThemes],
  parameters: { ...bothThemesParameters, layout: "padded" },
  args: {
    proposals: PROPOSALS,
    entities: ENTITIES,
    quotes: QUOTES,
    onHighlight: fn(),
    onPainted: fn(),
  },
} satisfies Meta<typeof ProposalsTray>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { args: { proposals: [] } };

/**
 * Live: every card in the proposed state's blue, with the linker's decision on its record (a
 * question with its candidates, the open account, a link by sound with its note beside the name),
 * its fields, quotes, and risks.
 */
export const Live: Story = {
  play: async ({ args, canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const cards = panel.getAllByRole("article");
    await expect(cards).toHaveLength(3);
    await expect(
      panel.getByRole("heading", { name: "Contact · Ask: Dana Li or a new record?" }),
    ).toBeVisible();
    const candidates = within(panel.getByRole("list", { name: "Candidates" }));
    await expect(candidates.getByText("Dana Li")).toBeVisible();
    await expect(candidates.getByText("38%")).toBeVisible();
    await expect(
      panel.getByRole("heading", { name: "Deal update · Acme Corp - Security Platform" }),
    ).toBeVisible();
    await expect(
      panel.getByRole("heading", { name: "Task · Dana Li, matched by sound" }),
    ).toBeVisible();
    await expect(panel.getByText("Pick the record")).toBeVisible();
    await expect(panel.getByText("Open account assumed")).toBeVisible();
    // An uncertain link is a note beside the name now, never a badge (ADR-0031's option 2).
    await expect(panel.queryByText("Linked by sound")).toBeNull();
    await expect(panel.getByText("Differs from what was said: due date")).toBeVisible();
    await expect(panel.getAllByText("Proposed")).toHaveLength(3);
    const first = cards[0] as HTMLElement;
    await userEvent.hover(first);
    await expect(args.onHighlight).toHaveBeenCalledWith(PROPOSALS[0]?.proposalId);
    await waitFor(() => expect(args.onPainted).toHaveBeenCalled());
  },
};

/** A replay shows each proposal's review status instead. */
export const Reviewed: Story = {
  args: { proposals: demoState({ reviewed: true }).projections.proposals, showReview: true },
  play: async ({ canvasElement }) => {
    await expect(within(themePanel(canvasElement)).getByText("Approved")).toBeVisible();
  },
};

/**
 * The second witness heard the name differently (Phase 4 WP9): the link by sound became a
 * question, and the conflict pill shows both readings. Read-only until Phase 5.
 */
export const WitnessConflict: Story = {
  args: { proposals: [WITNESS_CONFLICT] },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    await expect(
      panel.getByRole("heading", { name: "Task · Ask: Dana Li or a new record?" }),
    ).toBeVisible();
    const conflicts = within(panel.getByRole("list", { name: "Where the transcripts disagree" }));
    await expect(conflicts.getByText("Heard two ways")).toBeVisible();
    await expect(conflicts.getByText("“Donna”")).toBeVisible();
    await expect(panel.getByText("Transcripts disagree on the name")).toBeVisible();
  },
};

/** A session client that takes every review and snooze over the socket. */
const writer: ReviewWriter = {
  sessionId: SESSION_ID,
  sendReview: async (reviews) => [
    { ok: true, via: "socket", ids: reviews.map((review) => review.reviewId), seq: 9 },
  ],
  sendSnooze: async (snooze) => ({ ok: true, via: "socket", ids: [snooze.snoozeId], seq: 9 }),
};

/**
 * The live screen (Phase 5 WP6): the inbox's card in tray mode, reviewed here over the session
 * socket, with the inbox's keys scoped to the list. a accepts, the card moves to Reviewed with its
 * Undo, and u brings it back. axe runs on the list with the question's records numbered, in both
 * themes; with no toaster mounted, the messages go nowhere.
 */
export const Reviewing: Story = {
  args: {
    review: {
      writer,
      startedAt: "2026-11-20T14:14:00.000Z",
      endedAt: null,
      sealedAt: null,
    },
  },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    await expect(panel.getAllByRole("article")).toHaveLength(3);
    const question = panel.getByRole("article", {
      name: "Contact · Ask: Dana Li or a new record?",
    });
    await expect(within(question).getByRole("radiogroup", { name: "Which record?" })).toBeVisible();
    const deal = panel.getByRole("article", {
      name: "Deal update · Acme Corp - Security Platform",
    });
    deal.focus();
    await userEvent.keyboard("a");
    await waitFor(() =>
      expect(
        panel.queryByRole("article", { name: "Deal update · Acme Corp - Security Platform" }),
      ).toBeNull(),
    );
    await expect(panel.getByRole("region", { name: "Reviewed" })).toBeVisible();
    await userEvent.keyboard("u");
    await waitFor(() =>
      expect(
        panel.getByRole("article", { name: "Deal update · Acme Corp - Security Platform" }),
      ).toHaveFocus(),
    );
  },
};

/** Sealed: the tray says the debrief is done and links to the inbox, and keeps working. */
export const HandedOver: Story = {
  args: {
    review: {
      writer,
      startedAt: "2026-11-20T14:14:00.000Z",
      endedAt: "2026-11-20T14:16:00.000Z",
      sealedAt: "2026-11-20T14:17:00.000Z",
    },
  },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    await expect(panel.getByText(/This debrief is done\./)).toBeVisible();
    await expect(panel.getByRole("link", { name: "inbox" })).toHaveAttribute("href", "/inbox");
  },
};
