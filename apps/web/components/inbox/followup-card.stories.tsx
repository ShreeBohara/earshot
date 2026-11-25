import { bothThemes, bothThemesParameters, themePanel } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { FollowupCard } from "./followup-card";
import type { FollowupBinding } from "./use-review-list";

/** A question as the list hands it to its card (WP13): "When is it due?" about a task. */
const binding: FollowupBinding = {
  id: "followup:01a1c6e2-0000-7000-8000-00000000f001",
  question: {
    questionId: "01a1c6e2-0000-7000-8000-00000000f001",
    turnId: "01a1c6e2-0000-7000-8000-00000000a001",
    askedAbout: "01a1c6e2-0000-7000-8000-000000000004",
    field: "dueDate",
    rule: "due_date",
    text: "When is it due?",
    status: "open",
    answeredBy: null,
    seq: 12,
    ts: "2026-11-20T15:00:00.000Z",
    closedSeq: null,
    closedAt: null,
  },
  about: "Task · Sean Murphy",
  active: true,
  shortcuts: true,
  answering: false,
  text: "",
  busy: false,
  error: null,
  listening: false,
  canSpeak: false,
  answer: fn(),
  skip: fn(),
  close: fn(),
  onText: fn(),
  onSubmit: fn(),
  onSpeak: fn(),
  focused: fn(),
  cardRef: () => {},
};

/** The card as the inbox lays it out: right after its proposal's, in the group's list. */
function Question(props: { binding: FollowupBinding }) {
  return (
    <ol className="w-full max-w-2xl">
      <li>
        <FollowupCard binding={props.binding} />
      </li>
    </ol>
  );
}

const meta = {
  title: "Web/Inbox/FollowupCard",
  component: Question,
  decorators: [bothThemes],
  parameters: { ...bothThemesParameters, layout: "padded" },
  args: { binding },
} satisfies Meta<typeof Question>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Asked: a group named by its question and its proposal, Answer on C and Skip on R. */
export const Asked: Story = {
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const question = panel.getByRole("group", { name: "When is it due? · Task · Sean Murphy" });
    await expect(question).toHaveAttribute("tabindex", "0");
    await expect(panel.queryByRole("article")).toBeNull();
    await expect(within(question).getByRole("button", { name: /^Answer/ })).toHaveAttribute(
      "aria-keyshortcuts",
      "C",
    );
    await expect(within(question).getByRole("button", { name: /^Skip/ })).toHaveAttribute(
      "aria-keyshortcuts",
      "R",
    );
  },
};

/** Answering: the text box, focused, and words it couldn't read kept with their alert. */
export const Answering: Story = {
  args: {
    binding: {
      ...binding,
      answering: true,
      text: "whenever",
      error: "I couldn't read a date in “whenever”.",
    },
  },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const box = panel.getByLabelText("Your answer");
    await expect(box).toHaveValue("whenever");
    await expect(box).toHaveAttribute("aria-invalid", "true");
    await expect(box).toHaveAccessibleDescription("I couldn't read a date in “whenever”.");
    await expect(panel.getByRole("alert")).toHaveTextContent(/whenever/);
    await expect(panel.getByRole("button", { name: "Answer" })).toBeEnabled();
  },
};
