import { bothThemes, bothThemesParameters } from "@earshot/ui/lib/story-themes";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { Orb, staticLevels } from "./orb";

const meta = {
  title: "Components/Orb",
  component: Orb,
  decorators: [bothThemes],
  parameters: { ...bothThemesParameters, layout: "padded" },
  args: { label: "Microphone level", levels: staticLevels({ mic: 0, agent: 0 }), size: 160 },
} satisfies Meta<typeof Orb>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Armed and silent: one frame, then the loop stops. */
export const Quiet: Story = {
  play: async ({ canvasElement }) => {
    const orbs = canvasElement.querySelectorAll("[data-slot=orb]");
    await expect(orbs).toHaveLength(2);
  },
};

export const Speaking: Story = { args: { levels: staticLevels({ mic: 0.6, agent: 0 }) } };

export const AgentSpeaking: Story = { args: { levels: staticLevels({ mic: 0, agent: 0.5 }) } };

/** Reduced motion: a still disk, and a ring that shows the level without moving between levels. */
export const ReducedMotion: Story = {
  args: { renderer: "still", levels: staticLevels({ mic: 0.4, agent: 0 }) },
  play: async ({ canvasElement }) => {
    const orb = canvasElement.querySelector<HTMLElement>("[data-slot=orb]");
    await expect(orb?.dataset.renderer).toBe("still");
    await expect(orb?.dataset.animating).toBe("false");
  },
};

/** Without WebGL: CSS gradients scaled by the level. */
export const CssFallback: Story = {
  args: { renderer: "css", levels: staticLevels({ mic: 0.5, agent: 0.2 }) },
};

/** The docked mini-session's size. */
export const Small: Story = { args: { size: 32, levels: staticLevels({ mic: 0.3, agent: 0 }) } };
