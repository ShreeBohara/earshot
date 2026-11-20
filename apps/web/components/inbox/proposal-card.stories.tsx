import { bothThemes, bothThemesParameters, themePanel } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { cardModel } from "@/lib/inbox/card";
import type { InboxProposal } from "@/lib/inbox/types";
import {
  AMBIGUOUS,
  CONFLICT,
  ENTITIES,
  NAME_NOTE,
  NO_RECORD,
  PLAIN,
  QUESTION,
  QUIET,
  QUOTES,
  UPDATE,
} from "./fixtures";
import { type CardActions, ProposalCard, type ProposalCardProps } from "./proposal-card";

const actions: CardActions = {
  accept: fn(),
  reject: fn(),
  edit: fn(),
  snooze: fn(),
  correct: fn(),
  select: fn(),
  useCorrection: fn(),
  saveEdit: fn(),
  cancelEdit: fn(),
  closeCorrection: fn(),
  focused: fn(),
};

/** A card as the inbox lays it out: alone in its group's list. */
function Card(
  props: Omit<ProposalCardProps, "model" | "quotes" | "actions" | "cardRef" | "menuFinalFocus"> & {
    proposal: InboxProposal;
  },
) {
  return (
    <ol className="w-full max-w-2xl">
      <li>
        <ProposalCard
          {...props}
          model={cardModel(props.proposal, ENTITIES, QUOTES)}
          quotes={QUOTES}
          actions={actions}
          cardRef={() => {}}
          menuFinalFocus={() => true}
        />
      </li>
    </ol>
  );
}

const meta = {
  title: "Web/Inbox/ProposalCard",
  component: Card,
  decorators: [bothThemes],
  parameters: { ...bothThemesParameters, layout: "padded" },
  args: {
    proposal: PLAIN,
    headingLevel: 4,
    active: true,
    shortcuts: true,
    editing: false,
    correcting: false,
    choice: null,
    correctionChoice: null,
    hint: null,
  },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Unmarked: plain, with the words each value was heard as, and the actions with their keys. */
export const Unmarked: Story = {
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const card = panel.getByRole("article", { name: "Task · Sean Murphy" });
    await expect(card).not.toHaveAttribute("aria-describedby");
    await expect(panel.queryByText("Needs a check")).toBeNull();
    await expect(panel.getByText("“send Sean the deck”")).toBeVisible();
    const toolbar = panel.getByRole("toolbar", { name: "Actions: task" });
    await expect(within(toolbar).getByRole("button", { name: "Accept" })).toHaveAttribute(
      "aria-keyshortcuts",
      "A",
    );
  },
};

/** Quiet: a short note, no color. */
export const Quiet: Story = {
  args: { proposal: QUIET },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    await expect(panel.getByText("Open account assumed")).toBeVisible();
    await expect(panel.queryByText("Needs a check")).toBeNull();
  },
};

/** Quiet, by the name: a link made in context carries its note beside the record. */
export const NameNote: Story = {
  args: { proposal: NAME_NOTE },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    await expect(panel.getByRole("heading", { name: "Task · Pier Logistics" })).toBeVisible();
  },
};

/**
 * Loud, a question: amber, the first-person line (also the card's description), and the records
 * numbered 1 to 3 with their odds.
 */
export const Question: Story = {
  args: { proposal: QUESTION, choice: 1 },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const card = panel.getByRole("article", {
      name: "Contact · Ask: Dana Lee, Dana Li, or a new record?",
    });
    await expect(card).toHaveAccessibleDescription(
      "Contact, Dana Lee, needs a check: I'm not sure who you meant.",
    );
    await expect(panel.getByText("Needs a check")).toBeVisible();
    const choices = panel.getByRole("radiogroup", { name: "Which record?" });
    await expect(within(choices).getAllByRole("radio")).toHaveLength(3);
    await expect(
      within(choices).getByRole("radio", { name: /Dana Li, Akme Dynamics/ }),
    ).toBeChecked();
    await userEvent.click(within(choices).getByRole("radio", { name: /A new record/ }));
    await expect(actions.select).toHaveBeenCalledWith(QUESTION.proposalId, 2, "chooser");
  },
};

/** Loud, a conflict on a field: the two readings, the live transcript's and the second witness's. */
export const FieldConflict: Story = {
  args: { proposal: CONFLICT },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const choices = panel.getByRole("radiogroup", { name: "Which did you say?" });
    await expect(
      within(choices).getByRole("radio", { name: /“VP of Operating” the second witness/ }),
    ).toBeVisible();
  },
};

/** Loud, two readings of a date: offered as choices. */
export const TwoReadings: Story = {
  args: { proposal: AMBIGUOUS },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    await expect(
      panel.getByText(/I heard “next Friday”\. Did you mean the 27th or the 4th\?/),
    ).toBeVisible();
    await expect(panel.getByRole("radiogroup", { name: "Which did you mean?" })).toBeVisible();
  },
};

/** Loud, no record: the line says why, and Accept explains it can't. */
export const NoRecord: Story = {
  args: {
    proposal: NO_RECORD,
    hint: "There's no record to add this to. Reject it, or correct it with C.",
  },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    await expect(panel.getByRole("button", { name: "Accept" })).toHaveAccessibleDescription(
      "There's no record to add this to. Reject it, or correct it with C.",
    );
  },
};

/** An update: the CRM's value now, then the proposed one. */
export const Update: Story = {
  args: { proposal: UPDATE },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    await expect(panel.getByText("Presentation scheduled")).toBeVisible();
    await expect(panel.getByText("$32,000")).toBeVisible();
    await expect(panel.getByText("$40,000")).toBeVisible();
  },
};

/** Editing: each field labeled, the date's readings as choices; Enter saves, Esc cancels. */
export const Editing: Story = {
  args: { proposal: AMBIGUOUS, editing: true },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const title = panel.getByLabelText("Title");
    await expect(title).toHaveValue("Send Sean the deck");
    await expect(panel.getByRole("radiogroup", { name: "Due date" })).toBeVisible();
    await expect(panel.queryByRole("toolbar")).toBeNull();
  },
};

/** The correction panel: the record's candidates, numbered; the only place another record is offered. */
export const Correcting: Story = {
  args: { proposal: UPDATE, correcting: true },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const group = panel.getByRole("group", { name: "Correct the record" });
    await expect(
      within(group).getByRole("radio", {
        name: /Acme Corp - Platform 98%, the current record/,
      }),
    ).toBeVisible();
    await expect(within(group).getByRole("button", { name: "Use this record" })).toBeDisabled();
  },
};

/** With the shortcuts off: no keys on the buttons, and no aria-keyshortcuts. */
export const ShortcutsOff: Story = {
  args: { proposal: QUESTION, shortcuts: false },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    await expect(panel.getByRole("button", { name: "Accept" })).not.toHaveAttribute(
      "aria-keyshortcuts",
    );
  },
};
