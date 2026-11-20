// The pilot's results file (Phase 5 spec §4.8, WP7 step 2; ADR-0039): what "Download results"
// saves, `earshot-pilot-<participant>-<date>.json`, holding exactly the fields §4.8 lists and
// nothing else. The browser is named only by its engine and whether it's a phone or tablet: the
// user agent string is read here and never kept. `PilotResults` in `@earshot/evals/pilot` is the
// shape `pilot:analyze` reads, which a test holds this to.
import type { ProposalReviewedV2 } from "@earshot/core";

export interface PilotBrowser {
  readonly engine: "blink" | "gecko" | "webkit" | "unknown";
  readonly mobile: boolean;
}

export interface PilotResultsFile {
  readonly format: 1;
  readonly set: string;
  readonly setSha256: string;
  readonly participant: string;
  readonly order: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly browser: PilotBrowser;
  readonly reviews: readonly ProposalReviewedV2[];
  readonly practice: readonly ProposalReviewedV2[];
}

/** What the page reads of `navigator` to name the browser's engine. */
export interface NavigatorLike {
  readonly userAgent: string;
  readonly maxTouchPoints?: number;
  readonly userAgentData?: { readonly mobile?: boolean } | undefined;
}

/**
 * The browser's engine, and whether it's a phone or tablet, from the user agent (which isn't
 * kept). Every browser on iOS and iPadOS is WebKit; an iPad asks for the desktop site, so a
 * "Macintosh" with a touch screen is one.
 */
export function browserOf(navigator: NavigatorLike): PilotBrowser {
  const ua = navigator.userAgent;
  const ipad = ua.includes("Macintosh") && (navigator.maxTouchPoints ?? 0) > 1;
  const ios = /iPhone|iPad|iPod/.test(ua) || ipad;
  let engine: PilotBrowser["engine"] = "unknown";
  if (ios) engine = "webkit";
  else if (ua.includes("Firefox/")) engine = "gecko";
  else if (/Chrome\/|Chromium\/|Edg\//.test(ua)) engine = "blink";
  else if (ua.includes("AppleWebKit/")) engine = "webkit";
  const mobile = navigator.userAgentData?.mobile ?? (ios || /Mobi|Android/.test(ua));
  return { engine, mobile };
}

/** The file's name: `earshot-pilot-P1-2026-11-20.json`, with the participant's local date. */
export function resultsFileName(participant: string, at: Date): string {
  const date = [
    at.getFullYear(),
    String(at.getMonth() + 1).padStart(2, "0"),
    String(at.getDate()).padStart(2, "0"),
  ].join("-");
  return `earshot-pilot-${participant}-${date}.json`;
}

/** The results file: these fields, in this order, and nothing else. */
export function resultsFile(input: {
  readonly set: string;
  readonly setSha256: string;
  readonly participant: string;
  readonly order: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly browser: PilotBrowser;
  readonly reviews: readonly ProposalReviewedV2[];
  readonly practice: readonly ProposalReviewedV2[];
}): PilotResultsFile {
  return {
    format: 1,
    set: input.set,
    setSha256: input.setSha256,
    participant: input.participant,
    order: [...input.order],
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    browser: { engine: input.browser.engine, mobile: input.browser.mobile },
    reviews: [...input.reviews],
    practice: [...input.practice],
  };
}

/** The file's text: two-space JSON, so a participant can read it before handing it over. */
export function resultsText(file: PilotResultsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
