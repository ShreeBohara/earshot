"use client";

import { MAX_CORRECTION_TEXT_CHARS } from "@earshot/core";
import { Button } from "@earshot/ui/components/button";
import { Toolbar, ToolbarButton } from "@earshot/ui/components/toolbar";
import { MessageCircleQuestionIcon, MicIcon, SkipForwardIcon } from "lucide-react";
import { useId, useLayoutEffect, useRef } from "react";
import { ActionKey } from "./proposal-card";
import type { FollowupBinding } from "./use-review-list";

/**
 * A follow-up question's card (Phase 5 spec WP13; ADR-0038), right after the card it asks about:
 * "When is it due?". A focus stop of the list's roving focus like a card, but a group, not an
 * `<article>`, so it never counts as a proposal. c answers it, in a text box whose Enter sends the
 * answer as a correction of that field; r skips it. Answering replaces the proposal, as any
 * correction does, and the replacement takes the question's place in focus.
 */
export function FollowupCard({ binding }: { binding: FollowupBinding }) {
  const id = useId();
  const titleId = `${id}-title`;
  const inputId = `${id}-answer`;
  const errorId = `${id}-error`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const keys = (key: string) => (binding.shortcuts ? key : undefined);

  // Into the answer box as it opens.
  useLayoutEffect(() => {
    if (binding.answering) inputRef.current?.focus();
  }, [binding.answering]);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a roving focus stop, like the cards; a fieldset can't hold focus as one
    <div
      ref={binding.cardRef}
      role="group"
      aria-labelledby={titleId}
      tabIndex={binding.active ? 0 : -1}
      onFocus={binding.focused}
      data-inbox-followup=""
      data-followup-id={binding.question.questionId}
      className="ms-6 flex scroll-mt-24 scroll-mb-36 flex-col gap-2 rounded-xl border border-dashed bg-card p-3 text-card-foreground outline-none focus-visible:focus-ring"
    >
      <p id={titleId} className="flex items-start gap-2 font-medium text-sm">
        <MessageCircleQuestionIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>
          {binding.question.text} <span className="text-muted-foreground">· {binding.about}</span>
        </span>
      </p>
      {binding.answering ? (
        <div className="grid gap-1" data-followup-answer="">
          <label htmlFor={inputId} className="text-muted-foreground text-xs">
            Your answer
          </label>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              value={binding.text}
              maxLength={MAX_CORRECTION_TEXT_CHARS}
              autoComplete="off"
              disabled={binding.busy || binding.listening}
              aria-invalid={binding.error ? true : undefined}
              aria-describedby={binding.error ? errorId : undefined}
              onChange={(event) => binding.onText(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  binding.onSubmit(event);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  binding.close();
                }
              }}
              className="h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:focus-ring disabled:opacity-50 aria-invalid:border-destructive"
              data-slot="followup-text"
            />
            {binding.canSpeak ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={binding.busy}
                onClick={binding.onSpeak}
              >
                <MicIcon aria-hidden="true" data-icon="inline-start" />
                {binding.listening ? "Done" : "Say it"}
              </Button>
            ) : null}
          </div>
          {binding.listening ? (
            <p className="text-muted-foreground text-xs">
              Listening. Say the answer, then press Done.
            </p>
          ) : null}
          {binding.error ? (
            <p
              id={errorId}
              role="alert"
              className="text-destructive text-xs"
              data-slot="followup-error"
            >
              {binding.error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={binding.busy || binding.listening || binding.text.trim() === ""}
              onClick={(event) => binding.onSubmit(event)}
            >
              Answer
            </Button>
            <Button variant="ghost" size="sm" onClick={binding.close}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        <Toolbar aria-label="Actions: question">
          <ToolbarButton
            render={<Button size="sm" variant="outline" />}
            aria-keyshortcuts={keys("C")}
            disabled={binding.busy}
            onClick={(event) => binding.answer(event)}
          >
            Answer
            <ActionKey shortcuts={binding.shortcuts}>C</ActionKey>
          </ToolbarButton>
          <ToolbarButton
            render={<Button size="sm" variant="ghost" />}
            aria-keyshortcuts={keys("R")}
            disabled={binding.busy}
            onClick={(event) => binding.skip(event)}
          >
            <SkipForwardIcon aria-hidden="true" data-icon="inline-start" />
            Skip
            <ActionKey shortcuts={binding.shortcuts}>R</ActionKey>
          </ToolbarButton>
        </Toolbar>
      )}
    </div>
  );
}
