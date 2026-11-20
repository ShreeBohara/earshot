import { fromJsonl } from "@earshot/events";
import demoLog from "@earshot/events/fixtures/demo-session.jsonl";
import { Badge } from "@earshot/ui/components/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@earshot/ui/components/card";
import { StatePill } from "@earshot/ui/components/state-pill";
import { CheckIcon, PencilIcon, XIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DemoReplay } from "@/components/demo/demo-replay";
import { linkButton } from "@/components/link-button";
import { buildDemo, clock, type Demo, type DemoField, type DemoProposal } from "@/lib/demo";

export const metadata: Metadata = {
  title: "Replay demo · Earshot",
  description:
    "A recorded debrief replayed into CRM proposals, with the evidence behind every field.",
};

// Built once and served as static HTML: no database, no account, no key, no edge Worker, and no
// provider. The session log is bundled as a string (the *.jsonl rule in next.config.ts); the
// browser plays it over time, and the whole-session summary is replayed here at build time.
export const dynamic = "force-static";

const TYPE_LABELS: Record<string, string> = {
  note: "Note",
  task: "Task",
  contact: "New contact",
  deal_update: "Deal update",
  commitment: "Commitment",
};

const RISK_LABELS: Record<string, string> = {
  date: "Check the date",
  number: "Check the number",
  negation: "Check the negation",
  low_confidence: "Low confidence",
  unsupported: "No supporting words",
  new_entity: "Creates a new record",
  witness_conflict: "Transcripts disagree",
};

function fieldLabel(name: string): string {
  const words = name.replace(/([A-Z])/g, " $1").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function show(value: DemoField["value"]): string {
  if (value === null) return "None";
  return String(value);
}

function percent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function Decision({ status }: { status: DemoProposal["status"] }) {
  switch (status) {
    case "proposed":
      return <StatePill state="proposed" />;
    case "approved":
      return (
        <Badge variant="outline" className="h-6 gap-1.5 px-2.5">
          <CheckIcon aria-hidden="true" data-icon="inline-start" />
          Approved
        </Badge>
      );
    case "edited":
      return (
        <Badge variant="outline" className="h-6 gap-1.5 px-2.5">
          <PencilIcon aria-hidden="true" data-icon="inline-start" />
          Edited, then approved
        </Badge>
      );
    case "rejected":
      return (
        <Badge variant="outline" className="h-6 gap-1.5 px-2.5 text-muted-foreground">
          <XIcon aria-hidden="true" data-icon="inline-start" />
          Rejected
        </Badge>
      );
  }
}

function ProposalCard({ proposal }: { proposal: DemoProposal }) {
  const titleId = `proposal-${proposal.id}`;
  const wholeProposalRisks = proposal.riskFlags.filter((flag) => !flag.field);
  return (
    <Card aria-labelledby={titleId} role="article">
      <CardHeader>
        <CardTitle id={titleId}>{TYPE_LABELS[proposal.type] ?? proposal.type}</CardTitle>
        <CardAction>
          <Decision status={proposal.status} />
        </CardAction>
        {wholeProposalRisks.length > 0 && (
          <div className="col-span-2 flex flex-wrap gap-1.5 pt-1">
            {wholeProposalRisks.map((flag) => (
              <Badge key={flag.kind} variant="conflict">
                {RISK_LABELS[flag.kind] ?? flag.kind}
              </Badge>
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-4">
          {proposal.fields.map((field) => {
            const risk = proposal.riskFlags.find((flag) => flag.field === field.name);
            return (
              <div key={field.name} className="flex flex-col gap-1">
                <dt className="flex items-center gap-2">
                  <span className="font-mono text-muted-foreground text-xs uppercase tracking-wider">
                    {fieldLabel(field.name)}
                  </span>
                  {risk && <Badge variant="conflict">{RISK_LABELS[risk.kind] ?? risk.kind}</Badge>}
                </dt>
                <dd className="flex flex-col gap-1.5">
                  {field.editedTo === undefined ? (
                    <span className="font-medium">{show(field.value)}</span>
                  ) : (
                    <span className="flex flex-col gap-0.5">
                      <span className="text-muted-foreground line-through">
                        <span className="sr-only">Proposed: </span>
                        {show(field.value)}
                      </span>
                      <span className="font-medium">
                        <span className="sr-only">Changed by the reviewer to: </span>
                        {show(field.editedTo)}
                      </span>
                    </span>
                  )}
                  {field.evidence ? (
                    <span className="text-sm">
                      <a
                        href={`#u-${field.evidence.utteranceId}`}
                        className="border-state-proposed-border border-l-2 ps-2 text-muted-foreground italic outline-none hover:text-foreground focus-visible:focus-ring"
                      >
                        <span className="sr-only">Evidence: </span>“{field.evidence.quote}”
                      </a>{" "}
                      <span className="font-mono text-muted-foreground text-xs tabular-nums">
                        at {field.evidence.at} · heard with {percent(field.evidence.confidence)}{" "}
                        confidence
                      </span>
                    </span>
                  ) : (
                    <span className="text-destructive text-sm">No evidence found.</span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </CardContent>
    </Card>
  );
}

/** Today's static summary: the transcript, the proposals as reviewed, and the event log. */
function WholeSession({ demo }: { demo: Demo }) {
  return (
    <div className="flex flex-col gap-10">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <section aria-labelledby="transcript-heading" className="flex flex-col gap-4">
          <h2 id="transcript-heading" className="font-medium text-sm">
            Transcript
          </h2>
          <ol className="flex flex-col gap-1">
            {demo.utterances.map((utterance) => (
              <li
                key={utterance.id}
                id={`u-${utterance.id}`}
                className="grid scroll-mt-6 grid-cols-[3.5rem_1fr] gap-3 rounded-lg px-3 py-2 target:bg-state-proposed-bg target:ring-1 target:ring-state-proposed-border"
              >
                <span className="pt-0.5 font-mono text-muted-foreground text-xs tabular-nums">
                  {utterance.at}
                </span>
                <p className="text-pretty leading-relaxed">{utterance.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="proposals-heading" className="flex flex-col gap-4">
          <h2 id="proposals-heading" className="font-medium text-sm">
            Proposals <span className="text-muted-foreground">({demo.proposals.length})</span>
          </h2>
          <ul className="flex flex-col gap-4">
            {demo.proposals.map((proposal) => (
              <li key={proposal.id}>
                <ProposalCard proposal={proposal} />
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section aria-labelledby="log-heading" className="flex flex-col gap-3">
        <h2 id="log-heading" className="font-medium text-sm">
          Event log
        </h2>
        <details className="group rounded-lg border">
          <summary className="flex min-h-10 cursor-pointer items-center rounded-lg px-4 text-sm outline-none focus-visible:focus-ring">
            All {demo.events.length} events, in order
          </summary>
          <ol className="flex flex-col divide-y border-t font-mono text-xs">
            {demo.events.map((event) => (
              <li key={event.seq} className="grid grid-cols-[2.5rem_4rem_1fr_auto] gap-3 px-4 py-2">
                <span className="text-muted-foreground tabular-nums">#{event.seq}</span>
                <span className="text-muted-foreground tabular-nums">{event.at}</span>
                <span>{event.type}</span>
                <span className="text-muted-foreground">v{event.schemaVersion}</span>
              </li>
            ))}
          </ol>
        </details>
      </section>
    </div>
  );
}

export default function DemoPage() {
  const demo = buildDemo(demoLog);
  const log = fromJsonl(demoLog);
  const { session } = demo;
  const providers = session.providers as {
    speechToText?: { provider: string; model: string };
    llm?: { provider: string; model: string };
  };

  return (
    <div className="flex min-h-svh flex-col">
      <a
        href="#main"
        className="sr-only rounded-md bg-background px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus-visible:focus-ring"
      >
        Skip to content
      </a>
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-6">
          <Link
            href="/"
            className="rounded-sm font-serif text-xl tracking-tight outline-none focus-visible:focus-ring"
          >
            Earshot
          </Link>
          <span aria-hidden="true" className="text-muted-foreground">
            /
          </span>
          <p className="text-sm">Replay demo</p>
          <Link
            href="/sign-in"
            className={linkButton({ variant: "outline", size: "sm", className: "ms-auto" })}
          >
            Sign in
          </Link>
        </div>
      </header>

      <main id="main" className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-10">
        <header className="flex flex-col gap-3">
          <p className="font-mono text-muted-foreground text-xs uppercase tracking-wider">
            Replay · read only
          </p>
          <h1 className="font-serif text-5xl tracking-tight">A debrief, replayed</h1>
          <p className="max-w-prose text-pretty text-lg text-muted-foreground leading-relaxed">
            A rep&apos;s spoken notes after a call with Acme Corp, played back from the
            session&apos;s event log through the screen a live debrief uses: the words as they were
            said, each proposal as it arrived, then the rep&apos;s review. Every proposed field
            points to the words it came from.
          </p>
          <dl className="flex flex-wrap gap-x-6 gap-y-1 pt-1 font-mono text-muted-foreground text-xs">
            <div className="flex gap-1.5">
              <dt>Speech to text</dt>
              <dd className="text-foreground">
                {providers.speechToText
                  ? `${providers.speechToText.provider} ${providers.speechToText.model}`
                  : "n/a"}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Model</dt>
              <dd className="text-foreground">
                {providers.llm ? `${providers.llm.provider} ${providers.llm.model}` : "n/a"}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Length</dt>
              <dd className="text-foreground tabular-nums">
                {session.durationMs === null ? "n/a" : clock(session.durationMs)}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Cost</dt>
              <dd className="text-foreground tabular-nums">
                {session.costUsd === null ? "n/a" : `$${session.costUsd.toFixed(4)}`}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Events</dt>
              <dd className="text-foreground tabular-nums">{demo.events.length}</dd>
            </div>
          </dl>
        </header>

        <DemoReplay log={log} wholeSession={<WholeSession demo={demo} />} />

        <footer className="flex flex-wrap items-center gap-3 border-t pt-8">
          <p className="text-muted-foreground">Ready to debrief your own calls?</p>
          <Link href="/sign-in" className={linkButton()}>
            Sign in to Earshot
          </Link>
        </footer>
      </main>
    </div>
  );
}
