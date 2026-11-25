"use client";

import { type FieldValue, MAX_CORRECTION_TEXT_CHARS } from "@earshot/core";
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
  DatabaseIcon,
  EllipsisIcon,
  MicIcon,
  PencilIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { type MouseEvent, type Ref, useId, useLayoutEffect, useRef, useState } from "react";
import { NO_AUDIO_COPY, type NoAudioReason } from "@/lib/evidence/copy";
import { type CardEvidence, type PlayableSpan, targetWords } from "@/lib/evidence/state";
import type { CardModel, ThreeWayRow } from "@/lib/inbox/card";
import type { InputEventLike } from "@/lib/inbox/input";
import { type SnoozeOption, snoozeUntil, whenWords } from "@/lib/inbox/time";
import type { InboxProposal } from "@/lib/inbox/types";
import { CaptureLink } from "../capture/link";
import { PlayEvidenceButton } from "../evidence/play-evidence";
import { ChoiceList } from "./choice-list";
import { EditForm } from "./edit-form";
import type { CorrectionBinding } from "./use-review-list";

/** What a card asks of the page. The page decides, sends, and moves focus. */
export interface CardActions {
  /** Accept; on a 3-way card, "Keep mine". */
  accept(proposalId: string, event: InputEventLike): void;
  /** "Keep the CRM's" on a 3-way card (WP12): an edit to the CRM's values now. */
  keepCrm(proposalId: string, event: InputEventLike): void;
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

/**
 * A card's demo controls in More (Phase 5 WP12), only where its record is a demo record:
 * "Simulate a CRM change" and "Add a matching record".
 */
export interface CardDemo {
  readonly simulate?: () => void;
  readonly addMatching?: () => void;
}

export interface ProposalCardProps {
  proposal: InboxProposal;
  model: CardModel;
  quotes: Readonly<Record<string, string>>;
  /**
   * The card's heading level: under an inbox debrief's heading (4), or an account's (5); under the
   * capture screen's "Proposals" (3), in the tray.
   */
  headingLevel: 3 | 4 | 5;
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
  /**
   * A line saying why the card has no audio to play, where none ever exists: the pilot's written
   * debriefs (WP7). With it, the card never offers playback.
   */
  audioNote?: string;
  /**
   * Evidence clips (WP9): which of the card's words this device can play, and the line saying why
   * the rest can't. The inbox and the tray pass it (`EvidenceCard`); without it the card is as it
   * was before clips.
   */
  evidence?: CardEvidence;
  /** The demo controls in More (WP12): the inbox passes them on demo records only. */
  demo?: CardDemo;
  /**
   * The correction panel's field picker and text box (WP13): the inbox and the tray pass it. The
   * pilot doesn't, and its panel keeps only the candidates.
   */
  correction?: CorrectionBinding;
}

/**
 * A field whose CRM value moved since the proposal (WP12), its three values in one line: "Discovery
 * when you spoke · Proposal in the CRM now (changed 2 h ago) · you said Negotiation". The dots are
 * hidden from screen readers, which hear commas instead.
 */
function ThreeWayValue({ row }: { row: ThreeWayRow }) {
  const dot = (
    <>
      <span aria-hidden="true" className="text-muted-foreground">
        ·
      </span>
      <span className="sr-only">, </span>
    </>
  );
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5" data-slot="three-way">
      <span>
        <span className="text-muted-foreground">{row.base}</span> when you spoke
      </span>
      {dot}
      <span>
        <span className="font-medium text-state-conflict-text">{row.current}</span> in the CRM now
        {row.ago ? <span className="text-muted-foreground"> (changed {row.ago})</span> : null}
      </span>
      {dot}
      <span>
        you said <span className="font-medium">{row.proposed}</span>
      </span>
    </span>
  );
}

/** The words a field was heard as, with a button that plays them where this device can. */
function HeardLine({ heard, play }: { heard: string | null; play: PlayableSpan | undefined }) {
  if (heard) {
    return (
      <span className="block font-mono text-muted-foreground text-xs">
        <span className="sr-only">Heard: </span>“{heard}”
        {play ? <PlayEvidenceButton span={play} /> : null}
      </span>
    );
  }
  return play ? (
    <span className="block">
      <PlayEvidenceButton span={play} />
    </span>
  ) : null;
}

/** The card's line for a reason it has no audio; "Settings → Capture" is a link where it's named. */
function NoAudioLine({ reason }: { reason: NoAudioReason }) {
  const text = NO_AUDIO_COPY[reason];
  const place = "Settings → Capture";
  const at = reason === "clips_off" ? text.indexOf(place) : -1;
  return (
    <p className="text-muted-foreground text-xs" data-slot="no-audio" data-reason={reason}>
      {at < 0 ? (
        text
      ) : (
        <>
          {text.slice(0, at)}
          <CaptureLink
            href="/settings/capture"
            className="rounded-sm underline underline-offset-4 outline-none hover:text-foreground focus-visible:focus-ring"
          >
            {place}
          </CaptureLink>
          {text.slice(at + place.length)}
        </>
      )}
    </p>
  );
}

export function ActionKey({ shortcuts, children }: { shortcuts: boolean; children: string }) {
  return shortcuts ? (
    <Kbd aria-hidden="true" className="ms-0.5 h-4 min-w-4 bg-current/15 px-1 text-current">
      {children}
    </Kbd>
  ) : null;
}

/** The correction panel's line under its choices: what the keys and the text box do. */
function correctionHint(
  correction: CorrectionBinding | undefined,
  shortcuts: boolean,
  candidates: boolean,
): string {
  if (!correction) {
    return shortcuts && candidates
      ? "Press a number to choose it and accept, or Esc to close."
      : "Choose a record and use it, or close this.";
  }
  if (correction.field === "target" && candidates) {
    return shortcuts
      ? "Press a number to choose it and accept, or type the right one and press Enter."
      : "Choose a record and use it, or type the right one.";
  }
  return "Type what's right and press Enter, or close this.";
}

/** The panel's field picker (WP13): the record, preselected on a card about one, or a field. */
function CorrectionField({ id, correction }: { id: string; correction: CorrectionBinding }) {
  const fieldId = `${id}-correction-field`;
  return (
    <div className="grid gap-1">
      <label htmlFor={fieldId} className="text-muted-foreground text-xs">
        What's wrong
      </label>
      <select
        id={fieldId}
        value={correction.field}
        disabled={correction.busy || correction.listening}
        onChange={(event) => correction.onField(event.target.value)}
        className="h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:focus-ring disabled:opacity-50"
        data-slot="correction-field"
      >
        {correction.fields.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The panel's text box (WP13): Enter sends it, and its words are read on the server. A failure
 * stays here, the words kept: "I couldn't read a date in “whenever suits”." On the capture screen
 * while the session is live, the microphone takes the next thing said instead.
 */
function CorrectionText({
  id,
  correction,
  model,
}: {
  id: string;
  correction: CorrectionBinding;
  model: CardModel;
}) {
  const textId = `${id}-correction-text`;
  const errorId = `${id}-correction-error`;
  const label =
    correction.field === "target"
      ? model.correction.length > 0
        ? "Or type the record's name"
        : "The record's name"
      : `The right ${(correction.fields.find((option) => option.value === correction.field)?.label ?? "value").toLowerCase()}`;
  return (
    <div className="grid gap-1">
      <label htmlFor={textId} className="text-muted-foreground text-xs">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={textId}
          type="text"
          value={correction.text}
          maxLength={MAX_CORRECTION_TEXT_CHARS}
          autoComplete="off"
          disabled={correction.busy || correction.listening}
          aria-invalid={correction.error ? true : undefined}
          aria-describedby={correction.error ? errorId : undefined}
          onChange={(event) => correction.onText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            correction.onSubmit(event);
          }}
          className="h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:focus-ring disabled:opacity-50 aria-invalid:border-destructive"
          data-correction-text=""
        />
        {correction.canSpeak ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={correction.busy}
            onClick={correction.onSpeak}
            data-slot="correction-speak"
          >
            <MicIcon aria-hidden="true" data-icon="inline-start" />
            {correction.listening ? "Done" : "Say it"}
          </Button>
        ) : null}
      </div>
      {correction.listening ? (
        <p className="text-muted-foreground text-xs" data-slot="correction-listening">
          Listening. Say what's right, then press Done.
        </p>
      ) : null}
      {correction.error ? (
        <p
          id={errorId}
          role="alert"
          className="text-destructive text-xs"
          data-slot="correction-error"
        >
          {correction.error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A proposal in the inbox (spec WP5 step 3), and in the capture screen's tray (WP6), an
 * `<article>` in its group's list: a focus stop of
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
  audioNote,
  evidence: clips,
  demo,
  correction,
}: ProposalCardProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const hintId = `${id}-hint`;
  const { proposalId } = proposal;
  const loud = model.tier.tier === "loud";
  const Heading = headingLevel === 3 ? "h3" : headingLevel === 4 ? "h4" : "h5";
  const keys = (key: string) => (shortcuts ? key : undefined);
  const [now] = useState(() => new Date());
  const correctionRef = useRef<HTMLFieldSetElement | null>(null);
  // The pilot's line rules out clips: its debriefs were never recorded.
  const evidence = audioNote ? undefined : clips;
  const targetPlay = evidence?.target ?? null;
  const targetAt = targetPlay ? targetWords(model) : null;

  // Into the correction panel as it opens: its picked record, or its first, else its text box.
  useLayoutEffect(() => {
    if (!correcting) return;
    const panel = correctionRef.current;
    const target =
      panel?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
      panel?.querySelector<HTMLElement>('[role="radio"]') ??
      panel?.querySelector<HTMLElement>("input[data-correction-text]") ??
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
          <span>
            {model.firstPerson.text}
            {targetPlay && targetAt === "first_person" ? (
              <PlayEvidenceButton span={targetPlay} />
            ) : null}
          </span>
        </p>
      ) : null}

      {model.mention && !model.firstPerson ? (
        <p className="font-mono text-muted-foreground text-xs">
          <span className="sr-only">Record named as: </span>“{model.mention}”
          {targetPlay && targetAt === "mention" ? <PlayEvidenceButton span={targetPlay} /> : null}
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
                {field.threeWay ? (
                  <ThreeWayValue row={field.threeWay} />
                ) : field.before !== null && field.changes ? (
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
                <HeardLine heard={field.heard} play={evidence?.fields[field.name]} />
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

      {audioNote && !editing ? (
        <p className="text-muted-foreground text-xs" data-slot="no-audio">
          {audioNote}
        </p>
      ) : null}

      {evidence?.note && !editing ? <NoAudioLine reason={evidence.note} /> : null}

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
          {correction ? <CorrectionField id={id} correction={correction} /> : null}
          {correction && correction.field !== "target" ? null : model.correction.length > 0 ? (
            <ChoiceList
              label="Which is it?"
              options={model.correction}
              value={correctionChoice}
              shortcuts={shortcuts}
              onSelect={(index) => actions.select(proposalId, index, "correction")}
            />
          ) : correction ? null : (
            <p className="text-muted-foreground text-sm">
              No other records came close. Reject it if it isn't right.
            </p>
          )}
          <p className="text-muted-foreground text-xs">
            {correctionHint(correction, shortcuts, model.correction.length > 0)}
          </p>
          {correction ? <CorrectionText id={id} correction={correction} model={model} /> : null}
          <div className="flex flex-wrap gap-2">
            {model.correction.length > 0 && (!correction || correction.field === "target") ? (
              <Button
                size="sm"
                disabled={correctionChoice === null}
                onClick={(event) => actions.useCorrection(proposalId, event)}
              >
                Use this record
              </Button>
            ) : null}
            {correction ? (
              <Button
                size="sm"
                variant={
                  model.correction.length > 0 && correction.field === "target"
                    ? "outline"
                    : "default"
                }
                disabled={correction.busy || correction.listening || correction.text.trim() === ""}
                onClick={(event) => correction.onSubmit(event)}
                data-slot="correction-submit"
              >
                Correct it
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
            aria-keyshortcuts={keys(model.keepCrm && !model.chooser ? "A 1" : "A")}
            aria-describedby={hint ? hintId : undefined}
            onClick={accept}
          >
            <CheckIcon aria-hidden="true" data-icon="inline-start" />
            {model.keepCrm ? "Keep mine" : "Accept"}
            <ActionKey shortcuts={shortcuts}>A</ActionKey>
          </ToolbarButton>
          {model.keepCrm ? (
            <ToolbarButton
              render={<Button size="sm" variant="outline" />}
              aria-keyshortcuts={model.chooser ? undefined : keys("2")}
              onClick={(event) => actions.keepCrm(proposalId, event)}
              data-slot="keep-crm"
            >
              <DatabaseIcon aria-hidden="true" data-icon="inline-start" />
              Keep the CRM's
              {model.chooser ? null : <ActionKey shortcuts={shortcuts}>2</ActionKey>}
            </ToolbarButton>
          ) : null}
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
              {demo ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Demo CRM</DropdownMenuLabel>
                    {demo.simulate ? (
                      <DropdownMenuItem onClick={demo.simulate} data-slot="demo-simulate">
                        Simulate a CRM change
                      </DropdownMenuItem>
                    ) : null}
                    {demo.addMatching ? (
                      <DropdownMenuItem onClick={demo.addMatching} data-slot="demo-add">
                        Add a matching record
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuGroup>
                </>
              ) : null}
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
