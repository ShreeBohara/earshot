import { StatePill } from "@earshot/ui/components/state-pill";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";

const STATES = ["proposed", "conflict", "synced", "failed", "neutral"] as const;

const meta = {
  title: "Components/StatePill",
  component: StatePill,
  args: { state: "conflict" },
  argTypes: { state: { control: "inline-radio", options: STATES } },
} satisfies Meta<typeof StatePill>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** Every state, with and without its icon, with a custom label, and as a 24px button. */
export const States: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {STATES.map((state) => (
          <StatePill key={state} state={state} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {STATES.map((state) => (
          <StatePill key={state} state={state} hideIcon />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatePill state="proposed">Amount: $48,000</StatePill>
        <StatePill state="conflict">Close date changed in CRM</StatePill>
        <StatePill state="synced">Synced 2m ago</StatePill>
        <StatePill state="failed">Rate limited</StatePill>
        <StatePill state="conflict" render={<button type="button" />}>
          2 alternatives
        </StatePill>
      </div>
    </div>
  ),
};

export const StatesDark: Story = {
  ...States,
  name: "States (dark)",
  globals: { theme: "dark" },
};

/** As a button, the pill is focusable, shows the ring, and activates from the keyboard. */
export const AsButton: Story = {
  args: { onClick: fn(), render: <button type="button" />, children: "Review conflict" },
  play: async ({ args, canvas, userEvent }) => {
    const pill = canvas.getByRole("button", { name: "Review conflict" });
    await expect(pill.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
    await userEvent.tab();
    await expect(pill).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(args.onClick).toHaveBeenCalledOnce();
  },
};
