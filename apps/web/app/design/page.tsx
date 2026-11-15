import { Badge } from "@earshot/ui/components/badge";
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@earshot/ui/components/dialog";
import { Field, FieldDescription, FieldLabel } from "@earshot/ui/components/field";
import { Input } from "@earshot/ui/components/input";
import { Kbd, KbdGroup } from "@earshot/ui/components/kbd";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@earshot/ui/components/popover";
import { StatePill } from "@earshot/ui/components/state-pill";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@earshot/ui/components/tabs";
import { Toaster } from "@earshot/ui/components/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@earshot/ui/components/tooltip";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ApiKeyField, SyncToastButton } from "./demos";

export const metadata: Metadata = {
  title: "Design system · Earshot",
  robots: { index: false },
};

const STATES = ["proposed", "conflict", "synced", "failed", "neutral"] as const;
const BUTTON_VARIANTS = [
  "default",
  "outline",
  "secondary",
  "ghost",
  "destructive",
  "link",
] as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <h2 id={id} className="font-medium text-sm">
        {title}
      </h2>
      <div className="flex flex-wrap items-start gap-4">{children}</div>
    </section>
  );
}

// A server component: it renders all ten components from @earshot/ui, so client components get
// server-rendered props and children here, and only ./demos ships its own client code.
export default function DesignPage() {
  return (
    <main className="mx-auto flex min-h-svh max-w-3xl flex-col gap-12 px-6 py-16">
      <header className="flex flex-col gap-3">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-wider">
          @earshot/ui
        </p>
        <h1 className="font-serif text-5xl tracking-tight">Components</h1>
        <p className="text-muted-foreground">
          The first ten, rendered by Next. Press <Kbd>D</Kbd> to switch between light and dark.
        </p>
      </header>

      <Section id="button" title="Button">
        {BUTTON_VARIANTS.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
      </Section>

      <Section id="field" title="Input and Field">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <Field>
            <FieldLabel>Workspace name</FieldLabel>
            <Input defaultValue="Acme sales" />
            <FieldDescription>Shown to everyone in your workspace.</FieldDescription>
          </Field>
          <ApiKeyField />
        </div>
      </Section>

      <Section id="state-pill" title="StatePill">
        {STATES.map((state) => (
          <StatePill key={state} state={state} />
        ))}
        <Badge variant="outline">Badge</Badge>
      </Section>

      <Section id="card" title="Card">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Acme renewal</CardTitle>
            <CardDescription>From your call with Dana Ruiz, 14 Nov</CardDescription>
            <CardAction>
              <StatePill state="proposed" />
            </CardAction>
          </CardHeader>
          <CardContent>Amount: $48,000. Close date: 15 Jan 2027.</CardContent>
          <CardFooter className="gap-2">
            <Button size="sm">Approve</Button>
            <Button size="sm" variant="outline">
              Edit
            </Button>
          </CardFooter>
        </Card>
      </Section>

      <Section id="dialog" title="Dialog">
        <Dialog>
          <DialogTrigger render={<Button variant="outline" />}>Add API key</DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add your OpenAI key</DialogTitle>
              <DialogDescription>
                Earshot keeps it on this device and calls OpenAI directly.
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel>API key</FieldLabel>
              <Input placeholder="sk-…" />
            </Field>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button>Save key</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Section>

      <Section id="popover" title="Popover">
        <Popover>
          <PopoverTrigger
            render={<StatePill state="conflict" render={<button type="button" />} />}
            aria-label="Amount conflict: show alternatives"
          >
            Conflict
          </PopoverTrigger>
          <PopoverContent>
            <PopoverHeader>
              <PopoverTitle>Amount changed in the CRM</PopoverTitle>
              <PopoverDescription>Pick the value to sync.</PopoverDescription>
            </PopoverHeader>
            <Button variant="outline">From the call: $48,000</Button>
            <Button variant="outline">In HubSpot now: $40,000</Button>
          </PopoverContent>
        </Popover>
      </Section>

      <Section id="tooltip" title="Tooltip">
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" />}>Evidence at 12:41</TooltipTrigger>
          <TooltipContent>“we can do forty-eight”, 12:41</TooltipContent>
        </Tooltip>
      </Section>

      <Section id="tabs" title="Tabs">
        <Tabs defaultValue="general" className="w-full max-w-sm">
          <TabsList aria-label="Settings">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="keys">Keys</TabsTrigger>
            <TabsTrigger value="sync">Sync</TabsTrigger>
          </TabsList>
          <TabsContent value="general">Workspace name, timezone, and theme.</TabsContent>
          <TabsContent value="keys">Your provider keys, stored on this device.</TabsContent>
          <TabsContent value="sync">Which CRM fields Earshot may write.</TabsContent>
        </Tabs>
      </Section>

      <Section id="toast" title="Toast">
        <SyncToastButton />
      </Section>

      <Section id="kbd" title="Kbd">
        <p className="flex items-center gap-2 text-sm">
          <Kbd>J</Kbd> <Kbd>K</Kbd> to move, <Kbd>A</Kbd> to approve, and
          <KbdGroup>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
          for commands.
        </p>
      </Section>

      <Toaster />
    </main>
  );
}
