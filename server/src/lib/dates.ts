/** Today's date in UTC as YYYY-MM-DD, matching Postgres `date` columns. */
export function todayISO(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
