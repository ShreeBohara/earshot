import { bothThemes, bothThemesParameters, themePanel } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { evidenceSpans } from "@/lib/capture/mentions";
import { ENTITIES, PROPOSALS, TRANSCRIPT } from "./fixtures";
import { LiveTranscript } from "./live-transcript";

const meta = {
  title: "Web/Capture/LiveTranscript",
  component: LiveTranscript,
  decorators: [bothThemes],
  parameters: { ...bothThemesParameters, layout: "padded" },
  args: { lines: TRANSCRIPT, partial: null, entities: ENTITIES },
} satisfies Meta<typeof LiveTranscript>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { args: { lines: [], partial: null } };

/** Finished lines in the polite log; the partial below it is hidden from assistive tech. */
export const Speaking: Story = {
  args: { lines: TRANSCRIPT.slice(0, 2), partial: "I need to send Dana the pricing" },
  play: async ({ canvasElement }) => {
    const panel = within(themePanel(canvasElement));
    const log = panel.getByRole("log", { name: "Transcript" });
    await expect(log).toHaveAttribute("aria-live", "polite");
    await expect(log.querySelectorAll("p")).toHaveLength(2);
    const partial = themePanel(canvasElement).querySelector("[data-slot=partial]");
    await expect(partial).toHaveAttribute("aria-hidden", "true");
    await expect(log).not.toContainElement(partial as HTMLElement);
  },
};

/** CRM names are underlined as mentions, never as links. */
export const Mentions: Story = {
  play: async ({ canvasElement }) => {
    const mentions = themePanel(canvasElement).querySelectorAll("[data-mention]");
    await expect([...mentions].map((m) => m.textContent)).toEqual(["Acme Corp"]);
    await expect(themePanel(canvasElement).querySelector("a")).toBeNull();
  },
};

/** Hovering the new-contact card marks the words it quotes. */
export const EvidenceHighlighted: Story = {
  args: { highlights: evidenceSpans(PROPOSALS[0]?.fields ?? {}) },
  play: async ({ canvasElement }) => {
    const marks = themePanel(canvasElement).querySelectorAll("mark");
    await expect([...marks].map((m) => m.textContent)).toEqual(["Dana Lee", "VP of Operations"]);
  },
};
