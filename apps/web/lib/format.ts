const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });
const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "14 Nov 2026". Server-rendered in UTC, so server and browser agree. */
export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "Unknown date";
  return dateFormat.format(new Date(date));
}

/** "3 hours ago", "yesterday", or a date once it's over a month old. */
export function formatRelative(date: Date | string, now: Date = new Date()): string {
  const seconds = Math.round((new Date(date).getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return "just now";
  if (abs < 3600) return relativeFormat.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relativeFormat.format(Math.round(seconds / 3600), "hour");
  if (abs < 30 * 86_400) return relativeFormat.format(Math.round(seconds / 86_400), "day");
  return formatDate(date);
}
