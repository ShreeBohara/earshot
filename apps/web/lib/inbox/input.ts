// Which input made a review (`input` on `proposal.reviewed` v2): a key, a pointer, or touch. A click
// that came from Enter or Space on a button is the keyboard's: Chromium and Safari give it no
// pointer type (and a `detail` of 0); a tap is `touch`; the rest are `pointer`.
import type { ReviewInputKind } from "@earshot/core";

/** What a click or key event carries that says which input made it. */
export interface InputEventLike {
  readonly type?: string;
  readonly detail?: number;
  readonly nativeEvent?: unknown;
  readonly pointerType?: string;
}

export function inputOf(event: InputEventLike | null | undefined): ReviewInputKind {
  if (!event) return "keyboard";
  if (event.type?.startsWith("key")) return "keyboard";
  const native = (event.nativeEvent ?? event) as { pointerType?: unknown; detail?: unknown };
  const pointerType = typeof native.pointerType === "string" ? native.pointerType : undefined;
  if (pointerType === "touch") return "touch";
  if (pointerType === "mouse" || pointerType === "pen") return "pointer";
  const detail = typeof event.detail === "number" ? event.detail : native.detail;
  return detail === 0 ? "keyboard" : "pointer";
}
