import { bothThemes, bothThemesParameters, themePanel } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";
import type { NoAudioReason } from "@/lib/evidence/copy";
import type { CardEvidence, PlayableSpan } from "@/lib/evidence/state";
import { cardModel } from "@/lib/inbox/card";
import type { InboxProposal } from "@/lib/inbox/types";
import {
  AMBIGUOUS,
  CONFLICT,
  CRM_CHANGED,
  ENTITIES,
  NAME_NOTE,
  NO_RECORD,
  PLAIN,
  QUESTION,
  QUIET,
  QUOTES,
  RELINK,
  UPDATE,
} from "./fixtures";
import { type CardActions, ProposalCard, type ProposalCardProps } from "./proposal-card";

const actions: CardActions = {
  accept: fn(),
  keepCrm: fn(),
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

/** The page's clock in every story: two hours after the CRM moved in `CRM_CHANGED`. */
const STORY_NOW = Date.parse("2026-11-20T15:00:00.000Z");

const demo = { simulate: fn(), addMatching: fn() };

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
          model={cardModel(props.proposal, ENTITIES, QUOTES, STORY_NOW)}
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
    await expect(
      panel.getByRole("heading", { name: "Task · Pier Logistics, matched in context" }),
    ).toBeVisible();
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

/**
 * The CRM moved after the rep spoke (Phase 5 WP12): loud, the field's three values, and Keep mine
 * (A or 1), Keep the CRM's (2), and Edit.
 */
export const CrmChanged: Story = {
  args: { proposal: CRM_CHANGED },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const card = panel.getByRole("article", { name: "Deal update · Acme Corp - Platform" });
    await expect(card).toHaveAccessibleDescription(
      "Deal update, Acme Corp - Platform, needs a check: The stage changed in your CRM after you spoke.",
    );
    await expect(panel.getByText("Needs a check")).toBeVisible();
    const row = canvasElement.querySelector("[data-slot=three-way]");
    await expect(row).toHaveTextContent(
      "Qualified to buy when you spoke·, Presentation scheduled in the CRM now (changed 2 h ago)·, you said proposal",
    );
    const toolbar = panel.getByRole("toolbar", { name: "Actions: deal update" });
    await expect(within(toolbar).getByRole("button", { name: "Keep mine" })).toHaveAttribute(
      "aria-keyshortcuts",
      "A 1",
    );
    const keepCrm = within(toolbar).getByRole("button", { name: "Keep the CRM's" });
    await expect(keepCrm).toHaveAttribute("aria-keyshortcuts", "2");
    await userEvent.click(keepCrm);
    await expect(actions.keepCrm).toHaveBeenCalledWith(CRM_CHANGED.proposalId, expect.anything());
  },
};

/**
 * A record reached the CRM after the rep spoke (Phase 5 WP12): loud, "Is it this one?", and the
 * record numbered before "A new record".
 */
export const RelinkOffer: Story = {
  args: { proposal: RELINK },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    await expect(
      panel.getByText("Pier Logistics was added to your CRM after you spoke. Is it this one?"),
    ).toBeVisible();
    const choices = panel.getByRole("radiogroup", { name: "Which record?" });
    const radios = within(choices).getAllByRole("radio");
    await expect(radios).toHaveLength(2);
    await expect(
      within(choices).getByRole("radio", { name: /Pier Logistics added after you spoke/ }),
    ).toBeVisible();
  },
};

/** On a demo record, More offers the demo CRM's controls (Phase 5 WP12). */
export const DemoControls: Story = {
  args: { proposal: UPDATE, demo: { simulate: demo.simulate } },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    await userEvent.click(panel.getByRole("button", { name: "More" }));
    const item = await screen.findByRole("menuitem", { name: "Simulate a CRM change" });
    await expect(screen.queryByRole("menuitem", { name: "Add a matching record" })).toBeNull();
    await userEvent.click(item);
    await expect(demo.simulate).toHaveBeenCalled();
    // Closed and gone, focus guards and all, before axe reads the page.
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
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

/** A span the story's card can play: the key and length a card's evidence would carry. */
function playable(proposal: InboxProposal, field: string, seconds: number): PlayableSpan {
  return { key: `${proposal.proposalId}:${field}`, sessionId: "story", audioMs: [0, 900], seconds };
}

const UPDATE_CLIPS: CardEvidence = {
  target: playable(UPDATE, "target", 1),
  fields: { stage: playable(UPDATE, "stage", 1), amount: playable(UPDATE, "amount", 2) },
  note: null,
};

/**
 * Evidence clips (WP9): this device holds the turn's audio, so the record's words and each field's
 * have a play button named for what it plays. No single key: the inbox's keys stay as they were.
 */
export const WithClips: Story = {
  args: { proposal: UPDATE, evidence: UPDATE_CLIPS },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const buttons = panel.getAllByRole("button", { name: /^Play what you said/ });
    await expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Play what you said, 1 second",
      "Play what you said, 1 second",
      "Play what you said, 2 seconds",
    ]);
    for (const button of buttons) {
      await expect(button).not.toHaveAttribute("aria-keyshortcuts");
      await expect(button).toHaveTextContent("Play");
    }
    await expect(
      panel.queryByText(/No audio|deleted after|can't keep|too long|clips are off/),
    ).toBeNull();
  },
};

/** On a loud card, the target's button follows the first-person line that asks about it. */
export const WithClipsOnALoudCard: Story = {
  args: {
    proposal: QUESTION,
    evidence: {
      target: playable(QUESTION, "target", 1),
      fields: { name: playable(QUESTION, "name", 1), title: playable(QUESTION, "title", 2) },
      note: null,
    },
  },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const line = canvasElement.querySelector("[data-slot=first-person]");
    await expect(
      within(line as HTMLElement).getByRole("button", { name: "Play what you said, 1 second" }),
    ).toBeVisible();
    await expect(panel.getAllByRole("button", { name: /^Play what you said/ })).toHaveLength(3);
  },
};

const REASONS: readonly NoAudioReason[] = [
  "clips_off",
  "another_device",
  "expired",
  "unavailable",
  "too_long",
];

/** Every reason a card has no audio to play, each with its own line (§4.7), and no play button. */
export const NoAudio: Story = {
  render: (args) => (
    <div className="grid gap-4">
      {REASONS.map((reason) => (
        <Card key={reason} {...args} evidence={{ target: null, fields: {}, note: reason }} />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    for (const line of [
      "No audio on this device. It stays where you recorded it.",
      "The audio was deleted after 24 hours.",
      "This browser can't keep audio.",
      "That turn was too long to keep.",
    ]) {
      await expect(panel.getByText(line)).toBeVisible();
    }
    await expect(panel.getByRole("link", { name: "Settings → Capture" })).toHaveAttribute(
      "href",
      "/settings/capture",
    );
    await expect(panel.queryByRole("button", { name: /^Play what you said/ })).toBeNull();
  },
};
