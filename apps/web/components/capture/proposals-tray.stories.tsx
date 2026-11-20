import { bothThemes, bothThemesParameters, themePanel } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { demoState, ENTITIES, PROPOSALS, QUOTES, WITNESS_CONFLICT } from "./fixtures";
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
