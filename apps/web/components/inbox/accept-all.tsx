"use client";

import { Button } from "@earshot/ui/components/button";
import { CheckCheckIcon } from "lucide-react";
import { useId, useLayoutEffect, useRef } from "react";
import type { BatchPlan } from "@/lib/inbox/batch";
import type { CardModel } from "@/lib/inbox/card";
import {
  BATCH_COPY,
  batchButtonLabel,
  batchNoneReason,
  batchSummary,
  stayWords,
} from "@/lib/inbox/copy";
import type { InputEventLike } from "@/lib/inbox/input";

/**
 * "Accept all from this call" in a debrief's header (spec WP6 step 1): "Accept 3 unmarked", which
 * opens the checkpoint below it. With nothing unmarked it stays in the tab order, disabled, and
 * says why, beside it and as its description.
 */
export function AcceptAllButton({
  plan,
  open,
  id,
  checkpointId,
  onToggle,
}: {
  plan: BatchPlan;
  /** Whether this debrief's checkpoint is open. */
  open: boolean;
  /** The button's own id: the checkpoint returns focus to it when it closes. */
  id: string;
  checkpointId: string;
  onToggle: () => void;
}) {
  const reasonId = useId();
  const count = plan.accept.length;
  const disabled = count === 0;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Button
        id={id}
        variant="outline"
        size="sm"
        disabled={disabled}
        // Reachable and described while disabled, so a keyboard or screen reader user hears why.
        focusableWhenDisabled
        aria-expanded={disabled ? undefined : open}
        aria-controls={open && !disabled ? checkpointId : undefined}
        aria-describedby={disabled ? reasonId : undefined}
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        data-slot="accept-all"
        onClick={() => {
          if (!disabled) onToggle();
        }}
      >
        <CheckCheckIcon aria-hidden="true" data-icon="inline-start" />
        {batchButtonLabel(count)}
      </Button>
      {disabled ? (
        <span id={reasonId} className="text-muted-foreground text-xs">
          {batchNoneReason(plan.stay.map((stay) => stay.reason))}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The batch's checkpoint (spec WP6 step 1, decision 3): inline under its debrief's header, not a
 * dialog. It lists what will be accepted and what stays for review, and why each stays: the
 * structure is the checkpoint, so marked cards are never in a batch to begin with. Focus moves to
 * "Accept 3", which its summary describes ("3 will be accepted. 2 stay for review."); Esc or
 * Cancel closes it and returns focus to the header's button.
 */
export function BatchCheckpoint({
  plan,
  models,
  id,
  buttonId,
  onCancel,
  onConfirm,
}: {
  plan: BatchPlan;
  /** Each card's model, for its name and why it stays. */
  models: ReadonlyMap<string, CardModel>;
  id: string;
  /** The header's button, where focus returns. */
  buttonId: string;
  onCancel: () => void;
  onConfirm: (event: InputEventLike) => void;
}) {
  const titleId = useId();
  const summaryId = useId();
  const acceptsId = useId();
  const staysId = useId();
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const count = plan.accept.length;
  const stays = plan.stay.length;

  // Into the checkpoint as it opens.
  useLayoutEffect(() => {
    confirmRef.current?.focus();
  }, []);

  const cancel = () => {
    onCancel();
    document.getElementById(buttonId)?.focus();
  };

  const name = (proposalId: string) => {
    const model = models.get(proposalId);
    return model ? `${model.type} · ${model.record}` : "A proposal";
  };

  return (
    <fieldset
      id={id}
      aria-labelledby={titleId}
      data-inbox-checkpoint=""
      className="grid min-w-0 gap-3 rounded-xl border border-dashed bg-card p-4 text-card-foreground"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <h4 id={titleId} className="font-medium text-sm">
        {BATCH_COPY.title}
      </h4>
      <p id={summaryId} className="text-muted-foreground text-sm">
        {count > 0
          ? batchSummary(count, stays)
          : batchNoneReason(plan.stay.map((stay) => stay.reason))}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-1.5">
          <p id={acceptsId} className="font-medium text-xs">
            {BATCH_COPY.accepts} ({count})
          </p>
          {count > 0 ? (
            <ul aria-labelledby={acceptsId} className="grid gap-1 text-sm" data-slot="accepts">
              {plan.accept.map((proposal) => {
                const first = models.get(proposal.proposalId)?.fields[0];
                return (
                  <li key={proposal.proposalId} className="text-pretty">
                    {name(proposal.proposalId)}
                    {first ? (
                      <span className="block text-muted-foreground text-xs">
                        {first.label}: {first.value}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">Nothing.</p>
          )}
        </div>
        <div className="grid content-start gap-1.5">
          <p id={staysId} className="font-medium text-xs">
            {BATCH_COPY.stays} ({stays})
          </p>
          {stays > 0 ? (
            <ul aria-labelledby={staysId} className="grid gap-1 text-sm" data-slot="stays">
              {plan.stay.map(({ proposal, reason }) => {
                const model = models.get(proposal.proposalId);
                return (
                  <li key={proposal.proposalId} className="text-pretty">
                    {name(proposal.proposalId)}
                    {model ? (
                      <span className="block text-muted-foreground text-xs">
                        {stayWords(reason, model)}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">Nothing.</p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          ref={confirmRef}
          size="sm"
          disabled={count === 0}
          focusableWhenDisabled
          aria-describedby={summaryId}
          onClick={(event) => {
            if (count > 0) onConfirm(event);
          }}
        >
          <CheckCheckIcon aria-hidden="true" data-icon="inline-start" />
          Accept {count}
        </Button>
        <Button variant="ghost" size="sm" onClick={cancel}>
          {BATCH_COPY.cancel}
        </Button>
      </div>
    </fieldset>
  );
}
