export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export const personName = (first?: string | null, last?: string | null) =>
  [first, last].filter((p) => p && p !== "—").join(" ") || "—";

const dateFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const shortFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/** Format a YYYY-MM-DD date string (stored as a calendar date, no time zone). */
export function formatDay(iso: string | null | undefined, short = false): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00Z`);
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return short || sameYear ? shortFmt.format(d) : dateFmt.format(d);
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Relative due-date description, e.g. "2 days overdue", "due today". */
export function dueLabel(iso: string | null | undefined): {
  text: string;
  tone: "critical" | "attention" | "none";
} {
  if (!iso) return { text: "No due date", tone: "none" };
  const days = Math.round(
    (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`)) / 86_400_000,
  );
  if (days < 0) return { text: `${-days}d overdue`, tone: "critical" };
  if (days === 0) return { text: "Due today", tone: "attention" };
  if (days === 1) return { text: "Due tomorrow", tone: "attention" };
  if (days <= 7) return { text: `Due in ${days}d`, tone: "none" };
  return { text: formatDay(iso), tone: "none" };
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export function timeAgo(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const seconds = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(seconds / 86400), "day");
  return dateFmt.format(d);
}

export function formatDateTime(date: Date | string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(date),
  );
}

export const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;
