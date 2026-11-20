// Per-turn latency marks (spec §4.5, `TurnMarks`): release, last final, first proposal, and its
// card's paint, all on this page's clock. SessionDO turns them into `turn.measured`, so all four
// numbers come from one clock. A turn with no proposal sends none: it has no card to time.
import type { TurnMarks } from "@earshot/core";
import type { CaptureMode, TurnTrigger } from "@earshot/voice";

interface EndedTurn {
  readonly mode: CaptureMode;
  readonly speechEndMs: number;
  readonly finalMs: number;
}

const round = (ms: number) => Math.max(0, Math.round(ms * 10) / 10);

export class TurnMarksRecorder {
  readonly #send: (turnId: string, marks: TurnMarks) => void;
  /** Push-to-talk releases waiting for their turn's `turn_end`: one press, one turn, in order. */
  readonly #releases: number[] = [];
  #speechStoppedAt: number | null = null;
  readonly #lastFinal = new Map<string, number>();
  readonly #ended = new Map<string, EndedTurn>();
  readonly #proposalsOf = new Map<string, readonly string[]>();
  readonly #proposalAt = new Map<string, number>();
  readonly #paintAt = new Map<string, number>();
  readonly #sent = new Set<string>();

  constructor(send: (turnId: string, marks: TurnMarks) => void) {
    this.#send = send;
  }

  /** Push-to-talk went up. */
  released(at: number): void {
    this.#releases.push(at);
  }

  /** Hands-free: the engine stopped hearing speech. */
  speechStopped(at: number): void {
    this.#speechStoppedAt = at;
  }

  final(turnId: string, at: number): void {
    this.#lastFinal.set(turnId, at);
  }

  turnEnded(turnId: string, trigger: TurnTrigger, mode: CaptureMode, at: number): void {
    const speechEndMs =
      trigger === "ptt_release"
        ? (this.#releases.shift() ?? at)
        : mode === "hands_free"
          ? (this.#speechStoppedAt ?? at)
          : at;
    this.#ended.set(turnId, { mode, speechEndMs, finalMs: this.#lastFinal.get(turnId) ?? at });
    this.#lastFinal.delete(turnId);
    this.#flush(turnId);
  }

  /** A `proposal.created` event arrived (its `receivedAt`). */
  proposalArrived(proposalId: string, at: number): void {
    if (!this.#proposalAt.has(proposalId)) this.#proposalAt.set(proposalId, at);
  }

  turnCompleted(turnId: string, proposalIds: readonly string[]): void {
    this.#proposalsOf.set(turnId, proposalIds);
    this.#flush(turnId);
  }

  /** A proposal's card was painted. */
  painted(proposalId: string, at: number): void {
    if (this.#paintAt.has(proposalId)) return;
    this.#paintAt.set(proposalId, at);
    for (const [turnId, ids] of this.#proposalsOf) {
      if (ids.includes(proposalId)) this.#flush(turnId);
    }
  }

  #flush(turnId: string): void {
    if (this.#sent.has(turnId)) return;
    const ended = this.#ended.get(turnId);
    const ids = this.#proposalsOf.get(turnId);
    if (!ended || !ids || ids.length === 0) return;
    let first: { id: string; at: number } | undefined;
    for (const id of ids) {
      const at = this.#proposalAt.get(id);
      if (at !== undefined && (!first || at < first.at)) first = { id, at };
    }
    if (!first) return;
    const paintMs = this.#paintAt.get(first.id);
    if (paintMs === undefined) return;
    this.#sent.add(turnId);
    this.#ended.delete(turnId);
    this.#proposalsOf.delete(turnId);
    this.#send(turnId, {
      mode: ended.mode,
      speechEndMs: round(ended.speechEndMs),
      finalMs: round(ended.finalMs),
      proposalMs: round(first.at),
      paintMs: round(paintMs),
    });
  }
}
