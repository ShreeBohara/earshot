import type { RecapCreatedV1 } from "@earshot/core";
import { bothThemes, bothThemesParameters, themePanel } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { wordsFrom } from "@/lib/recap/view";
import { RecapPanel } from "./recap-panel";

// The recap as the inbox's group and the capture screen show it (Phase 5 spec WP10 step 8): each
// sentence opens the words it quotes, and the lens sits collapsed beneath. Both themes, with axe.

const U1 = "01a1c6e2-af90-75b5-a79c-eb5ca2f0a104";
const U2 = "01a1c6e2-b3c0-7d11-8a2e-5f6a7b8c9d01";
const U3 = "01a1c6e2-b7d0-7e22-9b3f-6a7b8c9d0e12";

const TEXTS: Record<string, string> = {
  [U1]: "Just left Acme Dynamics. Dana Lee wants to expand the rollout to two more plants.",
  [U2]: "I owe Dana Lee a revised quote by Friday.",
  [U3]: "She promised to bring their CFO to the next call, but onboarding took longer than they hoped.",
};

const span = (utteranceId: string, words: string) => {
  const text = TEXTS[utteranceId] ?? "";
  const start = text.indexOf(words);
  return {
    utteranceId,
    span: [start, start + words.length] as [number, number],
    audioMs: [1_000, 3_000] as [number, number],
    confidence: 0.92,
  };
};

const CREATED: RecapCreatedV1 = {
  recapId: "01a1c6e9-2a10-7b3c-8d4e-5f6a7b8c9d01",
  outcome: "created",
  reason: null,
  llm: { provider: "anthropic", model: "claude-haiku-5-5" },
  sentences: [
    {
      kind: "headline",
      text: "Dana Lee wants to expand the rollout to two more plants.",
      evidence: [span(U1, "Dana Lee wants to expand the rollout to two more plants")],
      weakSupport: false,
    },
    {
      kind: "next_step",
      text: "Send Dana Lee a revised quote by Friday.",
      evidence: [span(U2, "owe Dana Lee a revised quote"), span(U2, "by Friday")],
      weakSupport: false,
    },
    {
      kind: "commitment",
      text: "Dana will bring the CFO, who signs off, to the next call.",
      evidence: [span(U3, "promised to bring their CFO to the next call")],
      weakSupport: true,
    },
  ],
  dropped: 1,
  lens: {
    id: "meddic",
    fields: [
      { field: "metrics", quote: null, evidence: null },
      { field: "economic_buyer", quote: "their CFO", evidence: span(U3, "their CFO") },
      { field: "decision_criteria", quote: null, evidence: null },
      { field: "decision_process", quote: null, evidence: null },
      {
        field: "identified_pain",
        quote: "onboarding took longer than they hoped",
        evidence: span(U3, "onboarding took longer than they hoped"),
      },
      { field: "champion", quote: null, evidence: null },
    ],
  },
};

const meta = {
  title: "Web/Recap/RecapPanel",
  component: RecapPanel,
  decorators: [bothThemes],
  parameters: { ...bothThemesParameters, layout: "padded" },
  args: { recap: CREATED, wordsOf: wordsFrom(TEXTS), headingLevel: 4 },
} satisfies Meta<typeof RecapPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Each sentence opens its evidence; the lens is collapsed: "MEDDIC: 2 of 6 mentioned". */
export const WithLens: Story = {
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    await expect(panel.getByRole("heading", { level: 4, name: "Recap" })).toBeVisible();
    const step = panel.getByRole("button", { name: "Send Dana Lee a revised quote by Friday." });
    await expect(step).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(step);
    await expect(step).toHaveAttribute("aria-expanded", "true");
    await expect(panel.getByText("“owe Dana Lee a revised quote”")).toBeVisible();
    await expect(panel.getByText("“by Friday”")).toBeVisible();
    // A sentence that says more than its words: its note shows with the words.
    await userEvent.click(panel.getByRole("button", { name: /Dana will bring the CFO/ }));
    await expect(panel.getByText("Says more than these words do.")).toBeVisible();
    await expect(panel.getByText(/1 sentence was left out/)).toBeVisible();
    const lens = panel.getByRole("button", { name: "MEDDIC: 2 of 6 mentioned" });
    await expect(lens).toHaveAttribute("aria-expanded", "false");
    await expect(panel.queryByText("Economic buyer")).toBeNull();
    await userEvent.click(lens);
    await expect(panel.getByText("Economic buyer")).toBeVisible();
    await expect(panel.getAllByText("Not mentioned")).toHaveLength(4);
  },
};

/** A recap with no lens, under the capture screen's "Debrief ended" heading. */
export const WithoutLens: Story = {
  args: { recap: { ...CREATED, lens: null, dropped: 0 }, headingLevel: 3 },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    await expect(panel.getByRole("heading", { level: 3, name: "Recap" })).toBeVisible();
    await expect(panel.getByRole("heading", { level: 4, name: "Next steps" })).toBeVisible();
    await expect(panel.queryByText(/mentioned/)).toBeNull();
    await expect(panel.queryByText(/left out/)).toBeNull();
  },
};

/** No recap: the line saying why, and nothing else. */
export const Failed: Story = {
  args: {
    recap: {
      ...CREATED,
      outcome: "failed",
      reason: "timeout",
      sentences: [],
      dropped: 0,
      lens: null,
    },
  },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    await expect(panel.getByText("No recap: it didn't come back within 15 seconds.")).toBeVisible();
    await expect(panel.queryByRole("button")).toBeNull();
  },
};

/** Skipped: the debrief ended without a key. */
export const Skipped: Story = {
  args: {
    recap: {
      ...CREATED,
      outcome: "skipped",
      reason: "no_key",
      llm: null,
      sentences: [],
      dropped: 0,
      lens: null,
    },
  },
};
