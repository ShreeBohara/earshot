// Where a card's corrections and follow-up skips go (Phase 5 WP13; ADR-0038), as `sinks.ts` is for
// reviews: the inbox's sealed debriefs through `POST /api/sessions/:id/corrections`, the capture
// screen's live one over the session socket (the web route after the seal). A correction isn't
// optimistic: the words are read on the server, and the superseding card arrives from there, by the
// inbox reading itself again or the session's events, so a sink only says how it went.
import type {
  CorrectionRouteError,
  CorrectionRouteErrorBody,
  CorrectionRouteResponse,
  ProposalTypeV2,
} from "@earshot/core";
import { uuidv7 } from "@earshot/core";
import type { CorrectionDelivery, CorrectionRoute } from "@earshot/voice/session";
import { fieldLabel } from "@/lib/capture/copy";

/** Why a correction or a skip didn't go through, as the card says it. */
export type CorrectionFailure =
  | "unreadable"
  | "stale"
  | "too_many"
  | "not_sealed"
  | "unavailable"
  | "refused";

export type CorrectionOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: CorrectionFailure };

/** A typed correction, or a follow-up's typed answer, as a card sends it. */
export interface TypedCorrection {
  readonly sessionId: string;
  readonly proposalId: string;
  /** `target`, or one of the proposal type's fields. */
  readonly field: string;
  /** The follow-up question it answers, if any. */
  readonly questionId: string | null;
  readonly text: string;
}

/** A spoken correction's request: the next turn the rep says is its words. */
export interface SpokenRequest {
  readonly proposalId: string;
  readonly field: string;
  readonly questionId: string | null;
}

/**
 * Corrections by voice (WP13 step 6), on the capture screen while its session is live: the panel's
 * microphone arms the next turn as the correction's words.
 */
export interface SpokenCorrections {
  /** Starts listening for the correction; resolves once SessionDO has read it, or refused it. */
  start(request: SpokenRequest): Promise<CorrectionOutcome>;
  /** Stops listening (push-to-talk's release): the turn ends, and its words are read. */
  finish(): void;
}

export interface CorrectionSink {
  correct(correction: TypedCorrection): Promise<CorrectionOutcome>;
  skip(sessionId: string, questionId: string): Promise<CorrectionOutcome>;
  /** Present only while a live session can take a spoken correction. */
  readonly speech?: SpokenCorrections | undefined;
}

/** The rep's IANA time zone, which the route reads dates in; UTC where the browser won't say. */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

const ROUTE_CODES: ReadonlySet<CorrectionRouteError> = new Set([
  "unauthorized",
  "forbidden",
  "invalid_request",
  "too_large",
  "not_found",
  "not_sealed",
  "stale",
  "unreadable",
  "too_many",
  "server_error",
]);

/** A route's refusal, its code kept for whoever reads it. */
export class CorrectionRouteFailure extends Error {
  override readonly name = "CorrectionRouteFailure";
  readonly code: CorrectionRouteError | "unavailable";
  constructor(code: CorrectionRouteError | "unavailable") {
    super(`the correction route refused: ${code}`);
    this.code = code;
  }
}

/**
 * `POST /api/sessions/:id/corrections`, same-origin: the function `SessionClient` sends a sealed
 * session's typed corrections and skips with, and the inbox's sink's own request. Rejects with a
 * `CorrectionRouteFailure` naming the route's code.
 */
export function correctionRoute(
  sessionId: string,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): CorrectionRoute {
  return async (request) => {
    const body =
      request.t === "skip"
        ? request
        : {
            t: "correct" as const,
            correctionId: request.correctionId,
            proposalId: request.proposalId,
            field: request.field,
            ...(request.questionId ? { questionId: request.questionId } : {}),
            said: { input: "typed" as const, text: request.text },
            ...(browserTimeZone() ? { timeZone: browserTimeZone() } : {}),
          };
    let response: Response;
    try {
      response = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}/corrections`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new CorrectionRouteFailure("unavailable");
    }
    if (response.ok) {
      const answer = (await response.json()) as CorrectionRouteResponse;
      return { proposalId: answer.proposalId };
    }
    const refusal = (await response.json().catch(() => null)) as CorrectionRouteErrorBody | null;
    const code = refusal && ROUTE_CODES.has(refusal.error) ? refusal.error : "unavailable";
    throw new CorrectionRouteFailure(code);
  };
}

/** A route's or SessionDO's code as what the card says. */
export function failureOf(code: string): CorrectionFailure {
  switch (code) {
    case "unreadable":
    case "stale":
    case "too_many":
    case "not_sealed":
      return code;
    // SessionDO's limits: corrections in a window or in all, typed words, a chain, the time.
    case "turn_limit":
    case "duration_limit":
      return "too_many";
    case "unavailable":
    case "server_error":
    case "internal":
    case "closed":
    case "sealed":
      return "unavailable";
    default:
      return "refused";
  }
}

function outcomeOf(delivery: CorrectionDelivery): CorrectionOutcome {
  return delivery.ok ? { ok: true } : { ok: false, code: failureOf(delivery.code) };
}

/** The inbox's sink: every correction and skip through the route, the session sealed. */
export function routeCorrectionSink(fetchImpl?: typeof fetch): CorrectionSink {
  const send = async (
    sessionId: string,
    request: Parameters<CorrectionRoute>[0],
  ): Promise<CorrectionOutcome> => {
    try {
      await correctionRoute(sessionId, fetchImpl)(request);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        code: failureOf(error instanceof CorrectionRouteFailure ? error.code : "unavailable"),
      };
    }
  };
  return {
    correct: (correction) =>
      send(correction.sessionId, {
        t: "correct",
        correctionId: uuidv7(),
        proposalId: correction.proposalId,
        field: correction.field,
        ...(correction.questionId ? { questionId: correction.questionId } : {}),
        text: correction.text,
      }),
    skip: (sessionId, questionId) => send(sessionId, { t: "skip", questionId }),
  };
}

/** What the tray's sink sends with: the capture screen's session client. */
export interface CorrectionWriter {
  readonly sessionId: string;
  sendCorrection(input: {
    readonly turnId: string;
    readonly correctionId: string;
    readonly proposalId: string;
    readonly field: string;
    readonly questionId?: string;
    readonly typed?: { readonly utteranceId: string; readonly text: string };
  }): Promise<CorrectionDelivery>;
  sendFollowupSkip(questionId: string): Promise<CorrectionDelivery>;
}

/**
 * The tray's sink: over the session socket, a typed correction's words riding on `correct` (the
 * route after the seal, which the client handles), and the microphone while the session captures.
 */
export function socketCorrectionSink(
  writer: CorrectionWriter,
  speech?: SpokenCorrections,
): CorrectionSink {
  return {
    correct: async (correction) =>
      outcomeOf(
        await writer.sendCorrection({
          turnId: uuidv7(),
          correctionId: uuidv7(),
          proposalId: correction.proposalId,
          field: correction.field,
          ...(correction.questionId ? { questionId: correction.questionId } : {}),
          typed: { utteranceId: uuidv7(), text: correction.text },
        }),
      ),
    skip: async (_sessionId, questionId) => outcomeOf(await writer.sendFollowupSkip(questionId)),
    ...(speech ? { speech } : {}),
  };
}

/**
 * The fields a correction reads with the normalizers, by name: the same in every type that has
 * them (`FIELD_KINDS` in `@earshot/understanding/faithfulness`, which this page doesn't import, so
 * the browser doesn't carry chrono).
 */
const VALUE_WORDS: Readonly<Record<string, string>> = {
  dueDate: "a date",
  closeDate: "a date",
  date: "a date",
  time: "a time",
  amount: "an amount",
};

/** What a field's value is, for "I couldn't read a date in …". */
function kindWords(_type: ProposalTypeV2, field: string): string {
  if (field === "target") return "a record";
  return VALUE_WORDS[field] ?? `the ${fieldLabel(field).toLowerCase()}`;
}

/** At most this many characters of the words are quoted back, with an ellipsis past them. */
const QUOTED_CHARS = 60;

/**
 * What the card says when a correction didn't go through, in the first person for words it couldn't
 * read: "I couldn't read a date in “whenever suits them”." The words are the rep's own, from the
 * page, never from a server's answer.
 */
export function correctionFailureLine(
  failure: CorrectionFailure,
  context: {
    readonly type: ProposalTypeV2;
    readonly field: string;
    /** The typed words; null for a spoken correction, whose words the page didn't keep. */
    readonly words: string | null;
  },
): string {
  switch (failure) {
    case "unreadable": {
      const kind = kindWords(context.type, context.field);
      if (context.words === null) return `I couldn't read ${kind} in what you said.`;
      const words =
        context.words.length > QUOTED_CHARS
          ? `${context.words.slice(0, QUOTED_CHARS)}…`
          : context.words;
      return `I couldn't read ${kind} in “${words}”.`;
    }
    case "stale":
      return "That card changed since it loaded. Reload it and try again.";
    case "too_many":
      return "This debrief can't take more corrections, or this card was corrected too many times. Edit or reject it instead.";
    case "not_sealed":
      return "This debrief is still finishing. Try again in a minute.";
    case "unavailable":
      return "Earshot couldn't send that correction. Try again in a minute.";
    case "refused":
      return "That correction can't be made. Edit or reject the card instead.";
  }
}
