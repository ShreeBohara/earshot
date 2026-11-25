// The inbox's pages (Phase 5 spec WP5; ADR-0035): "Load older"'s cursor, and how the view puts a
// page it reads into the debriefs it holds. Pure and free of server code, so the loader
// (./load.ts) and the client view (components/inbox/inbox-view.tsx) share it.
import type { InboxData, InboxSession } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** "Load older"'s cursor: the last debrief shown, by start time and id. */
export function olderCursor(session: Pick<InboxSession, "startedAt" | "sessionId">): string {
  return `${session.startedAt}_${session.sessionId}`;
}

/** A cursor back as its parts, or null for anything else. */
export function parseOlderCursor(
  cursor: string | null | undefined,
): { startedAt: Date; sessionId: string } | null {
  if (typeof cursor !== "string" || cursor.length > 80) return null;
  const separator = cursor.indexOf("_");
  if (separator < 0) return null;
  const startedAt = cursor.slice(0, separator);
  const sessionId = cursor.slice(separator + 1);
  if (!ISO.test(startedAt) || !UUID.test(sessionId)) return null;
  const date = new Date(startedAt);
  return Number.isNaN(date.getTime())
    ? null
    : { startedAt: date, sessionId: sessionId.toLowerCase() };
}

/** The workspace's demo flag: the page's, or the one the view holds if the page doesn't say. */
function demoFlag(current: InboxData, page: InboxData): { demoCrm?: boolean } {
  const demoCrm = page.demoCrm ?? current.demoCrm;
  return demoCrm === undefined ? {} : { demoCrm };
}

/** The first page read again, with any older pages the view loaded kept after it. */
export function withFirstPage(current: InboxData, fresh: InboxData): InboxData {
  const ids = new Set(fresh.sessions.map((session) => session.sessionId));
  const older = current.sessions.filter(
    (session) =>
      !ids.has(session.sessionId) &&
      fresh.sessions.every((first) => first.startedAt >= session.startedAt),
  );
  return {
    sessions: [...fresh.sessions, ...older],
    entities: { ...current.entities, ...fresh.entities },
    quotes: { ...current.quotes, ...fresh.quotes },
    older: older.length > 0 ? current.older : fresh.older,
    loadedAt: fresh.loadedAt,
    ...demoFlag(current, fresh),
  };
}

/** "Load older": the older page after the debriefs the view holds, the workspace's demo flag kept. */
export function withOlderPage(current: InboxData, page: InboxData): InboxData {
  const ids = new Set(current.sessions.map((session) => session.sessionId));
  return {
    sessions: [...current.sessions, ...page.sessions.filter((s) => !ids.has(s.sessionId))],
    entities: { ...current.entities, ...page.entities },
    quotes: { ...current.quotes, ...page.quotes },
    older: page.older,
    loadedAt: current.loadedAt,
    ...demoFlag(current, page),
  };
}

/**
 * Where to read again the page that starts with one debrief: "Load older"'s cursor from the
 * debrief listed before it, or undefined (the first page) for the newest, or one the view doesn't
 * hold.
 */
export function cursorBefore(
  current: Pick<InboxData, "sessions">,
  sessionId: string,
): string | undefined {
  const at = current.sessions.findIndex((session) => session.sessionId === sessionId);
  const previous = at > 0 ? current.sessions[at - 1] : undefined;
  return previous ? olderCursor(previous) : undefined;
}

/**
 * A page read again from the middle of the debriefs the view holds: each one it holds takes its
 * fresh state and keeps its place, so "Load older" goes on where it was. A debrief the read found
 * past the view's last isn't added.
 */
export function withSessionsRead(current: InboxData, fresh: InboxData): InboxData {
  const read = new Map(fresh.sessions.map((session) => [session.sessionId, session]));
  return {
    sessions: current.sessions.map((session) => read.get(session.sessionId) ?? session),
    entities: { ...current.entities, ...fresh.entities },
    quotes: { ...current.quotes, ...fresh.quotes },
    older: current.older,
    loadedAt: current.loadedAt,
    ...demoFlag(current, fresh),
  };
}

/**
 * Reads again the page holding one debrief, and how to put it in place: the first page for the
 * newest debrief, else the page that starts with it. After a demo control acts on a card (WP12),
 * or a correction lands (WP13), the card shows what changed wherever "Load older" put it. Null when
 * the read failed.
 */
export async function readPageOf(
  current: Pick<InboxData, "sessions">,
  sessionId: string,
  reload: (before?: string) => Promise<InboxData | null>,
): Promise<{ fresh: InboxData; apply: (current: InboxData) => InboxData } | null> {
  const before = cursorBefore(current, sessionId);
  const fresh = await reload(before);
  if (!fresh) return null;
  return {
    fresh,
    apply: (now) =>
      before === undefined ? withFirstPage(now, fresh) : withSessionsRead(now, fresh),
  };
}
