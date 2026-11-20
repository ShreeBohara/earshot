// Times the inbox computes and says, in the reviewer's own time zone: when a snooze wakes (WP5 step
// 6: s snoozes until tomorrow at 9:00 local time, target; More offers three hours or next Monday),
// and when a debrief happened ("today, 2:14 pm"). Pure: each takes the time zone's clock as `now`,
// a Date read in the runtime's zone.

/** When a snooze ends, by the option the reviewer picked. */
export type SnoozeOption = "tomorrow" | "hours" | "monday";

/** The hour a day-long snooze wakes at (target). */
export const SNOOZE_WAKE_HOUR = 9;
/** How long More's short snooze lasts. */
export const SNOOZE_HOURS = 3;

function atWakeHour(day: Date): Date {
  const wake = new Date(day);
  wake.setHours(SNOOZE_WAKE_HOUR, 0, 0, 0);
  return wake;
}

/** When a snooze picked at `now` wakes. */
export function snoozeUntil(option: SnoozeOption, now: Date): Date {
  switch (option) {
    case "hours":
      return new Date(now.getTime() + SNOOZE_HOURS * 3_600_000);
    case "tomorrow": {
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      return atWakeHour(tomorrow);
    }
    case "monday": {
      // The next Monday after today: a week on, from a Monday.
      const monday = new Date(now);
      const ahead = (8 - now.getDay()) % 7 || 7;
      monday.setDate(now.getDate() + ahead);
      return atWakeHour(monday);
    }
  }
}

const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" });
const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const monthDayYear = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** "2:14 pm". */
export function clockTime(date: Date): string {
  return clock.format(date).replace(/ |\s/g, " ").replace("AM", "am").replace("PM", "pm");
}

function dayStart(date: Date): number {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

/**
 * A day as the inbox says it, from `now`: "today", "yesterday", "tomorrow", a weekday within the
 * week either side, then "Nov 16", or "Nov 16, 2025" in another year.
 */
export function dayWords(date: Date, now: Date): string {
  const days = Math.round((dayStart(date) - dayStart(now)) / 86_400_000);
  if (days === 0) return "today";
  if (days === -1) return "yesterday";
  if (days === 1) return "tomorrow";
  if (Math.abs(days) < 7) return weekday.format(date);
  return date.getFullYear() === now.getFullYear()
    ? monthDay.format(date)
    : monthDayYear.format(date);
}

/** "today, 2:14 pm": a debrief's time, or a snooze's. */
export function whenWords(date: Date, now: Date): string {
  return `${dayWords(date, now)}, ${clockTime(date)}`;
}

/** The same, with its first letter capitalized, to start a sentence or a heading part. */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The server's version, before the page knows the reviewer's time zone: the date and time in UTC,
 * said so ("Nov 16, 3:00 pm UTC"). The page replaces it once it hydrates.
 */
export function utcWords(date: Date): string {
  const day = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  })
    .format(date)
    .replace(/ |\s/g, " ")
    .replace("AM", "am")
    .replace("PM", "pm");
  return `${day}, ${time} UTC`;
}
