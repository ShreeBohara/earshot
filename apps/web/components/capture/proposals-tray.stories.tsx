import { bothThemes, bothThemesParameters, themePanel } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { demoState, ENTITIES, PROPOSALS, QUOTES } from "./fixtures";
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

/** Live: every card in the proposed state's blue, with its target, fields, quotes, and risks. */
export const Live: Story = {
  play: async ({ args, canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const cards = panel.getAllByRole("article");
    await expect(cards).toHaveLength(3);
    await expect(panel.getByRole("heading", { name: "Contact · New" })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Task · Acme Corp" })).toBeVisible();
    await expect(panel.getByText("Creates a record")).toBeVisible();
    await expect(panel.getByText("Check the date: due date")).toBeVisible();
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
