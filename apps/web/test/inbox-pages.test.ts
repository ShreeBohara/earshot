// The inbox's pages on the client (Phase 5 spec WP5, WP12): "Load older" keeps the workspace's demo
// flag, and a demo control's re-read reaches the page holding its card's debrief, wherever "Load
// older" put it, without disturbing the rest (two Codex findings on WP12).
import { describe, expect, it, vi } from "vitest";
import {
  cursorBefore,
  olderCursor,
  parseOlderCursor,
  readPageOf,
  withFirstPage,
  withOlderPage,
  withSessionsRead,
} from "@/lib/inbox/pages";
import type { InboxData, InboxSession } from "@/lib/inbox/types";

/** A debrief with only what paging reads, and a marker for which read it came from. */
function session(n: number, read = "first"): InboxSession {
  return {
    sessionId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    startedAt: new Date(Date.UTC(2026, 10, 25, 12, 0) - n * 60_000).toISOString(),
    read,
  } as unknown as InboxSession;
}

function data(sessions: InboxSession[], extra: Partial<InboxData> = {}): InboxData {
  return {
    sessions,
    entities: {},
    quotes: {},
    older: null,
    loadedAt: "2026-11-25T12:00:00.000Z",
    ...extra,
  };
}

const readOf = (page: InboxData) =>
  page.sessions.map((s) => (s as unknown as { read: string }).read);

describe("the inbox's pages", () => {
  it("keeps the workspace's demo flag when Load older adds a page that doesn't say", () => {
    const first = data([session(1), session(2)], { older: olderCursor(session(2)), demoCrm: true });
    const older = data([session(3, "older")], { older: null });
    const both = withOlderPage(first, older);
    expect(both.demoCrm).toBe(true);
    expect(both.sessions.map((s) => s.sessionId)).toEqual(
      [1, 2, 3].map((n) => session(n).sessionId),
    );
    expect(both.older).toBeNull();
    expect(both.loadedAt).toBe(first.loadedAt);
    // A page that does say wins: a CRM connected since is no longer the demo CRM.
    expect(withOlderPage(first, { ...older, demoCrm: false }).demoCrm).toBe(false);
    // And a view that never had the flag doesn't gain one.
    expect("demoCrm" in withOlderPage(data([session(1)]), older)).toBe(false);
  });

  it("re-reads the page that starts with a debrief: the first page for the newest", () => {
    const held = data([session(1), session(2), session(3)]);
    expect(cursorBefore(held, session(1).sessionId)).toBeUndefined();
    expect(cursorBefore(held, session(3).sessionId)).toBe(olderCursor(session(2)));
    expect(parseOlderCursor(cursorBefore(held, session(3).sessionId))).toEqual({
      startedAt: new Date(session(2).startedAt),
      sessionId: session(2).sessionId,
    });
    // One the view doesn't hold reads the first page.
    expect(cursorBefore(held, session(9).sessionId)).toBeUndefined();
  });

  it("puts a re-read page in place: the debriefs it holds take their fresh state, nothing is added", () => {
    const held = data([session(1), session(2), session(3)], {
      older: olderCursor(session(3)),
      demoCrm: true,
    });
    // The page from debrief 2 on, which runs past what the view holds.
    const fresh = data([session(2, "again"), session(3, "again"), session(4, "again")], {
      older: olderCursor(session(4)),
      quotes: { u: "words" },
    });
    const next = withSessionsRead(held, fresh);
    expect(readOf(next)).toEqual(["first", "again", "again"]);
    expect(next.older).toBe(held.older);
    expect(next.demoCrm).toBe(true);
    expect(next.quotes).toEqual({ u: "words" });
  });

  it("keeps older pages and the demo flag when the first page is read again", () => {
    const held = data([session(1), session(2), session(3, "older")], {
      older: olderCursor(session(3)),
      demoCrm: true,
    });
    const next = withFirstPage(held, data([session(1, "again"), session(2, "again")]));
    expect(readOf(next)).toEqual(["again", "again", "older"]);
    expect(next.older).toBe(held.older);
    expect(next.demoCrm).toBe(true);
  });

  it("reads the page holding a demo control's card, on the first page or a later one", async () => {
    const held = data([session(1), session(2), session(3, "older")], {
      older: olderCursor(session(3)),
      demoCrm: true,
    });
    const reload = vi.fn(async (before?: string) =>
      before === undefined
        ? data([session(1, "again"), session(2, "again")], { older: olderCursor(session(2)) })
        : data([session(3, "again")], { older: null }),
    );

    const later = await readPageOf(held, session(3).sessionId, reload);
    expect(reload).toHaveBeenLastCalledWith(olderCursor(session(2)));
    expect(readOf(later?.apply(held) as InboxData)).toEqual(["first", "first", "again"]);
    expect(later?.apply(held).older).toBe(held.older);

    const first = await readPageOf(held, session(1).sessionId, reload);
    expect(reload).toHaveBeenLastCalledWith(undefined);
    expect(readOf(first?.apply(held) as InboxData)).toEqual(["again", "again", "older"]);

    expect(await readPageOf(held, session(2).sessionId, async () => null)).toBeNull();
  });
});
