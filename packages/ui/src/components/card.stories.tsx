import { Button } from "@earshot/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@earshot/ui/components/card";
import { StatePill } from "@earshot/ui/components/state-pill";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Components/Card",
  component: Card,
  parameters: { layout: "padded" },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

function ProposalCard({ size }: { size?: "default" | "sm" }) {
  return (
    <Card size={size} className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Acme renewal</CardTitle>
        <CardDescription>From your call with Dana Ruiz, 14 Nov</CardDescription>
        <CardAction>
          <StatePill state="conflict" />
        </CardAction>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Amount</dt>
          <dd className="font-mono tabular-nums">$48,000</dd>
          <dt className="text-muted-foreground">Close date</dt>
          <dd className="font-mono tabular-nums">2027-01-15</dd>
        </dl>
      </CardContent>
      <CardFooter className="gap-2">
        <Button size="sm">Approve</Button>
        <Button size="sm" variant="outline">
          Edit
        </Button>
      </CardFooter>
    </Card>
  );
}

/** Default and small sizes; header, action, content, and footer; and a focusable card. */
export const Variants: Story = {
  render: () => (
    <div className="grid max-w-3xl gap-6 md:grid-cols-2">
      <ProposalCard />
      <ProposalCard size="sm" />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Just a header</CardTitle>
          <CardDescription>Cards don't need a footer.</CardDescription>
        </CardHeader>
      </Card>
      <Card className="w-full max-w-sm" role="article" tabIndex={0} aria-label="Focusable card">
        <CardContent>Inbox cards take focus for J/K navigation, and show the ring.</CardContent>
      </Card>
    </div>
  ),
};

export const VariantsDark: Story = {
  ...Variants,
  name: "Variants (dark)",
  globals: { theme: "dark" },
};
