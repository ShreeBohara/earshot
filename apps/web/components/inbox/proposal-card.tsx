"use client";

import type { FieldValue } from "@earshot/core";
import { Button } from "@earshot/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@earshot/ui/components/dropdown-menu";
import { Kbd } from "@earshot/ui/components/kbd";
import { StatePill } from "@earshot/ui/components/state-pill";
import { Toolbar, ToolbarButton } from "@earshot/ui/components/toolbar";
import { cn } from "@earshot/ui/lib/utils";
import {
  ArrowRightIcon,
  CheckIcon,
  EllipsisIcon,
  PencilIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { type MouseEvent, type Ref, useId, useLayoutEffect, useRef, useState } from "react";
import type { CardModel } from "@/lib/inbox/card";
import type { InputEventLike } from "@/lib/inbox/input";
import { type SnoozeOption, snoozeUntil, whenWords } from "@/lib/inbox/time";
import type { InboxProposal } from "@/lib/inbox/types";
import { ChoiceList } from "./choice-list";
import { EditForm } from "./edit-form";

/** What a card asks of the page. The page decides, sends, and moves focus. */
export interface CardActions {
  accept(proposalId: string, event: InputEventLike): void;
  reject(proposalId: string, event: InputEventLike): void;
  /** Opens the editor. */
  edit(proposalId: string, event: InputEventLike): void;
  snooze(proposalId: string, option: SnoozeOption, event: InputEventLike): void;
  /** Opens the correction panel (or, on a question, goes to its choices). */
  correct(proposalId: string, event: InputEventLike): void;
  /** Picks an option without deciding: the pointer or arrow keys in a choice list. */
  select(proposalId: string, index: number, from: "chooser" | "correction"): void;
  /** Decides with the option picked in the correction panel. */
  useCorrection(proposalId: string, event: InputEventLike): void;
  saveEdit(
    proposalId: string,
    values: Readonly<Record<string, FieldValue>>,
    event: InputEventLike,
  ): void;
  cancelEdit(proposalId: string): void;
  closeCorrection(proposalId: string): void;
  /** Focus arrived in the card (Tab, a click): it holds the roving focus now. */
  focused(proposalId: string): void;
}

export interface ProposalCardProps {
  proposal: InboxProposal;
  model: CardModel;
  quotes: Readonly<Record<string, string>>;
  /** The card's heading level: under a debrief's heading (4), or an account's (5). */
  headingLevel: 4 | 5;
  /** The card holding roving focus: the only one in the tab order. */
  active: boolean;
  /** Whether the single-key shortcuts are on (Settings → Review): then the keys show. */
  shortcuts: boolean;
  editing: boolean;
  correcting: boolean;
  /** The option picked in the chooser, and in the correction panel. */
  choice: number | null;
  correctionChoice: number | null;
  /** A short line the page wants under the card's actions, such as "Choose a record first". */
  hint: string | null;
  actions: CardActions;
  cardRef: Ref<HTMLElement>;
  /** Base UI's menu returns focus to its trigger; the page says when focus has moved on instead. */
  menuFinalFocus: () => boolean;
}

function ActionKey({ shortcuts, children }: { shortcuts: boolean; children: string }) {
  return shortcuts ? (
    <Kbd aria-hidden="true" className="ms-0.5 h-4 min-w-4 bg-current/15 px-1 text-current">
      {children}
    </Kbd>
  ) : null;
}

/**
 * A proposal in the inbox (spec WP5 step 3), an `<article>` in its group's list: a focus stop of
 * the list's roving focus, named by its heading and, when loud, described by its first-person line.
 * Inside: the record, the loud marker and line, the fields as diff rows with the words they were
 * heard as, the quiet notes, the chooser, the correction panel or the editor when open, and the
 * actions as a toolbar, each with `aria-keyshortcuts` while the shortcuts are on.
 */
export function ProposalCard({
  proposal,
  model,
  quotes,
  headingLevel,
  active,
  shortcuts,
  editing,
  correcting,
  choice,
  correctionChoice,
  hint,
  actions,
  cardRef,
  menuFinalFocus,
}: ProposalCardProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const hintId = `${id}-hint`;
  const { proposalId } = proposal;
  const loud = model.tier.tier === "loud";
  const Heading = headingLevel === 4 ? "h4" : "h5";
  const keys = (key: string) => (shortcuts ? key : undefined);
  const [now] = useState(() => new Date());
  const correctionRef = useRef<HTMLFieldSetElement | null>(null);

  // Into the correction panel as it opens: its picked record, or its first.
  useLayoutEffect(() => {
    if (!correcting) return;
    const panel = correctionRef.current;
    const target =
      panel?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
      panel?.querySelector<HTMLElement>('[role="radio"]') ??
      panel?.querySelector<HTMLElement>("button");
    target?.focus();
  }, [correcting]);

  const accept = (event: MouseEvent) => actions.accept(proposalId, event);
  return (
    <article
      ref={cardRef}
      data-inbox-card=""
      data-proposal-id={proposalId}
      data-tier={model.tier.tier}
      tabIndex={active ? 0 : -1}
      onFocus={() => actions.focused(proposalId)}
      aria-labelledby={titleId}
      aria-describedby={model.description ? descriptionId : undefined}
      className={cn(
        // The margins keep a focused card clear of the header and the toast as it scrolls in.
        "flex scroll-mt-24 scroll-mb-36 flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground outline-none focus-visible:focus-ring",
        loud && "border-s-4 border-s-state-conflict",
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <Heading id={titleId} className="font-medium text-sm">
          {model.type} <span className="text-muted-foreground">· {model.record}</span>
          {model.nameNote ? (
            <span className="font-normal text-muted-foreground text-xs" data-slot="name-note">
              , {model.nameNote}
            </span>
          ) : null}
        </Heading>
        {loud ? <StatePill state="conflict">Needs a check</StatePill> : null}
      </header>
      {model.description ? (
        <span id={descriptionId} hidden>
          {model.description}
        </span>
      ) : null}

      {model.firstPerson ? (
        <p
          className="flex items-start gap-2 rounded-lg border border-state-conflict-border bg-state-conflict-bg px-3 py-2 text-pretty text-sm text-state-conflict-text"
          data-slot="first-person"
        >
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{model.firstPerson.text}</span>
        </p>
      ) : null}

      {model.mention && !model.firstPerson ? (
        <p className="font-mono text-muted-foreground text-xs">
          <span className="sr-only">Record named as: </span>“{model.mention}”
        </p>
      ) : null}

      {editing ? (
        <EditForm
          proposal={proposal}
          quotes={quotes}
          onSave={(values, event) => actions.saveEdit(proposalId, values, event)}
          onCancel={() => actions.cancelEdit(proposalId)}
        />
      ) : model.fields.length > 0 ? (
        <dl className="grid gap-2 text-sm">
          {model.fields.map((field) => (
            <div key={field.name} className="grid gap-0.5">
              <dt className="text-muted-foreground text-xs">{field.label}</dt>
              <dd className="text-pretty">
                {field.before !== null && field.changes ? (
                  <span className="flex flex-wrap items-center gap-x-1.5">
                    <span className="text-muted-foreground">
                      <span className="sr-only">Now in the CRM: </span>
                      {field.before}
                    </span>
                    <ArrowRightIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                    <span>
                      <span className="sr-only">, proposed: </span>
                      {field.value}
                    </span>
                  </span>
                ) : (
                  <span>
                    {field.value}
                    {field.before !== null ? (
                      <span className="text-muted-foreground text-xs"> (the same in the CRM)</span>
                    ) : null}
                  </span>
                )}
                {field.heard ? (
                  <span className="block font-mono text-muted-foreground text-xs">
                    <span className="sr-only">Heard: </span>“{field.heard}”
                  </span>
                ) : null}
                {field.notes.map((note) => (
                  <span key={note} className="block text-muted-foreground text-xs" data-slot="note">
                    {note}
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {model.notes.length > 0 && !editing ? (
        <ul aria-label="Notes" className="grid gap-0.5 text-muted-foreground text-xs">
          {model.notes.map((note) => (
            <li key={note} data-slot="note">
              {note}
            </li>
          ))}
        </ul>
      ) : null}

      {model.chooser && !editing ? (
        <ChoiceList
          label={model.chooser.label}
          options={model.chooser.options}
          value={choice}
          shortcuts={shortcuts}
          onSelect={(index) => actions.select(proposalId, index, "chooser")}
        />
      ) : null}

      {correcting && !editing ? (
        <fieldset
          ref={correctionRef}
          data-inbox-correction=""
          className="grid min-w-0 gap-2 rounded-lg border border-dashed p-3"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              actions.closeCorrection(proposalId);
            }
          }}
        >
          <legend className="px-1 font-medium text-sm">Correct the record</legend>
          {model.correction.length > 0 ? (
            <ChoiceList
              label="Which is it?"
              options={model.correction}
              value={correctionChoice}
              shortcuts={shortcuts}
              onSelect={(index) => actions.select(proposalId, index, "correction")}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              No other records came close. Reject it if it isn't right.
            </p>
          )}
          <p className="text-muted-foreground text-xs">
            {shortcuts && model.correction.length > 0
              ? "Press a number to choose it and accept, or Esc to close."
              : "Choose a record and use it, or close this."}
          </p>
          <div className="flex flex-wrap gap-2">
            {model.correction.length > 0 ? (
              <Button
                size="sm"
                disabled={correctionChoice === null}
                onClick={(event) => actions.useCorrection(proposalId, event)}
              >
                Use this record
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => actions.closeCorrection(proposalId)}>
              Close
            </Button>
          </div>
        </fieldset>
      ) : null}

      {editing ? null : (
        <Toolbar aria-label={`Actions: ${model.type.toLowerCase()}`} className="pt-1">
          <ToolbarButton
            render={<Button size="sm" />}
            aria-keyshortcuts={keys("A")}
            aria-describedby={hint ? hintId : undefined}
            onClick={accept}
          >
            <CheckIcon aria-hidden="true" data-icon="inline-start" />
            Accept
            <ActionKey shortcuts={shortcuts}>A</ActionKey>
          </ToolbarButton>
          <ToolbarButton
            render={<Button size="sm" variant="outline" />}
            aria-keyshortcuts={keys("E")}
            onClick={(event) => actions.edit(proposalId, event)}
          >
            <PencilIcon aria-hidden="true" data-icon="inline-start" />
            Edit
            <ActionKey shortcuts={shortcuts}>E</ActionKey>
          </ToolbarButton>
          <ToolbarButton
            render={<Button size="sm" variant="outline" />}
            aria-keyshortcuts={keys("R")}
            onClick={(event) => actions.reject(proposalId, event)}
          >
            <XIcon aria-hidden="true" data-icon="inline-start" />
            Reject
            <ActionKey shortcuts={shortcuts}>R</ActionKey>
          </ToolbarButton>
          <DropdownMenu>
            <ToolbarButton
              render={<DropdownMenuTrigger render={<Button size="sm" variant="ghost" />} />}
            >
              <EllipsisIcon aria-hidden="true" data-icon="inline-start" />
              More
            </ToolbarButton>
            <DropdownMenuContent align="start" finalFocus={menuFinalFocus}>
              <DropdownMenuGroup>
                <DropdownMenuLabel>Snooze</DropdownMenuLabel>
                <DropdownMenuItem
                  aria-keyshortcuts={keys("S")}
                  onClick={(event) => actions.snooze(proposalId, "tomorrow", event)}
                >
                  Until {whenWords(snoozeUntil("tomorrow", now), now)}
                  <ActionKey shortcuts={shortcuts}>S</ActionKey>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={(event) => actions.snooze(proposalId, "hours", event)}>
                  For 3 hours
                </DropdownMenuItem>
                <DropdownMenuItem onClick={(event) => actions.snooze(proposalId, "monday", event)}>
                  Until {whenWords(snoozeUntil("monday", now), now)}
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                aria-keyshortcuts={keys("C")}
                onClick={(event) => actions.correct(proposalId, event)}
              >
                Correct the record
                <ActionKey shortcuts={shortcuts}>C</ActionKey>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Toolbar>
      )}
      {hint ? (
        <p id={hintId} className="text-muted-foreground text-xs" data-slot="hint">
          {hint}
        </p>
      ) : null}
    </article>
  );
}
