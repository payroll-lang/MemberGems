export const TZ = 'Asia/Kolkata';

/** ISO timestamp (UTC) for storage. */
export function nowIso(d: Date = new Date()): string {
  return d.toISOString();
}

/** Today's date in India as 'yyyy-MM-dd'. */
export function todayIst(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}
