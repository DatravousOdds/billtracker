import type { ISODate } from '../types';

// Calendar-date helpers. Everything works in UTC internally so time zones
// and daylight-saving changes never shift a due date by a day.

export function toDate(iso: ISODate): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toISO(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

/** Today's date on this device, as 'YYYY-MM-DD'. */
export function todayISO(now = new Date()): ISODate {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(iso: ISODate, days: number): ISODate {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toISO(d);
}

export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
}

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Add months, keeping the original day of month where possible.
 * Jan 31 + 1 month → Feb 28 (or 29), not Mar 3.
 */
export function addMonths(iso: ISODate, months: number, anchorDay?: number): ISODate {
  const d = toDate(iso);
  const day = anchorDay ?? d.getUTCDate();
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  return toISO(new Date(Date.UTC(y, m, Math.min(day, daysInMonth(y, m)))));
}

/** The Sunday that starts the week containing this date. */
export function weekStart(iso: ISODate): ISODate {
  return addDays(iso, -toDate(iso).getUTCDay());
}

const short = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const long = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

export function formatShort(iso: ISODate): string {
  return short.format(toDate(iso));
}

export function formatLong(iso: ISODate): string {
  return long.format(toDate(iso));
}
