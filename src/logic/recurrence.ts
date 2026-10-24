import type { Bill, ISODate, Recurrence } from '../types';
import { addDays, addMonths, daysBetween, toDate } from './dates';

/** How many times a bill comes due in an average month. */
export const PER_MONTH: Record<Recurrence, number> = {
  once: 0,
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
};

const MONTH_STEP: Partial<Record<Recurrence, number>> = { monthly: 1, quarterly: 3, yearly: 12 };
const DAY_STEP: Partial<Record<Recurrence, number>> = { weekly: 7, biweekly: 14 };

/** All due dates of a bill between `from` and `to` (both inclusive). */
export function dueDates(bill: Pick<Bill, 'recurrence' | 'start_date'>, from: ISODate, to: ISODate): ISODate[] {
  const start = bill.start_date;
  // Dates are compared as strings, which only works for 4-digit years. A year like 10000
  // would never pass `to` and loop for seconds before throwing.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return [];
  if (to < from || to < start) return [];
  const out: ISODate[] = [];

  if (bill.recurrence === 'once') {
    if (start >= from && start <= to) out.push(start);
    return out;
  }

  const dayStep = DAY_STEP[bill.recurrence];
  if (dayStep) {
    // Jump straight to the first occurrence on or after `from`.
    const skip = from > start ? Math.ceil(daysBetween(start, from) / dayStep) : 0;
    for (let d = addDays(start, skip * dayStep); d <= to; d = addDays(d, dayStep)) out.push(d);
    return out;
  }

  const monthStep = MONTH_STEP[bill.recurrence]!;
  const anchorDay = toDate(start).getUTCDate();
  let n = 0;
  if (from > start) {
    const s = toDate(start);
    const f = toDate(from);
    const monthsApart = (f.getUTCFullYear() - s.getUTCFullYear()) * 12 + (f.getUTCMonth() - s.getUTCMonth());
    n = Math.max(0, Math.floor(monthsApart / monthStep) - 1);
  }
  for (;; n++) {
    const d = addMonths(start, n * monthStep, anchorDay);
    if (d > to) break;
    if (d >= from) out.push(d);
  }
  return out;
}

/** A bill's next due date on or after `today` (within ~13 months), or null if none. */
export function nextDue(bill: Pick<Bill, 'recurrence' | 'start_date'>, today: ISODate): ISODate | null {
  return dueDates(bill, today, addDays(today, 400))[0] ?? null;
}

/** Bills ordered by next due date; bills with no upcoming date go last in either direction. */
export function sortByNextDue<T extends Pick<Bill, 'recurrence' | 'start_date'>>(bills: T[], today: ISODate, desc: boolean): T[] {
  return bills
    .map((bill) => ({ bill, due: nextDue(bill, today) }))
    .sort((a, b) => {
      if (!a.due || !b.due) return a.due ? -1 : b.due ? 1 : 0;
      return desc ? b.due.localeCompare(a.due) : a.due.localeCompare(b.due);
    })
    .map((x) => x.bill);
}

/** Groups bills by category, keeping their order; groups appear in order of their first bill. */
export function groupByCategory<T extends Pick<Bill, 'category'>>(bills: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const b of bills) groups.set(b.category, [...(groups.get(b.category) ?? []), b]);
  return [...groups];
}

/** A bill's average cost per month, in cents (one-time bills count as 0). */
export function monthlyEquivalent(bill: Pick<Bill, 'recurrence' | 'amount_cents'>): number {
  return bill.amount_cents * PER_MONTH[bill.recurrence];
}

export const RECURRENCE_LABEL: Record<Recurrence, string> = {
  once: 'One time',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Every 3 months',
  yearly: 'Yearly',
};
