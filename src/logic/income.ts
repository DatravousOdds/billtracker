import type { ISODate, Member, PayFrequency, Paycheck } from '../types';
import { addDays, addMonths } from './dates';
import { dueDates } from './recurrence';

/** Paychecks per year for each pay schedule. */
export const PER_YEAR: Record<PayFrequency, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
};

export const FREQUENCY_LABEL: Record<PayFrequency, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  semimonthly: 'Twice a month',
  monthly: 'Monthly',
};

/** Paycheck amount → average monthly income (cents). */
export function monthlyFromPaycheck(amountCents: number, frequency: PayFrequency): number {
  return (amountCents * PER_YEAR[frequency]) / 12;
}

export interface IncomeResult {
  monthlyCents: number;
  /** 'fixed' = from the usual paycheck; 'auto' / 'per_paycheck' = from logged paychecks; 'fallback' = per-paycheck mode but not enough logged yet. */
  source: 'fixed' | 'auto' | 'per_paycheck' | 'fallback';
  paychecksUsed: number;
}

/** Paychecks needed (and used) for a logged average: one month's worth. Weekly 4, biweekly 2, twice a month 2, monthly 1. */
export const paychecksNeeded = (f: PayFrequency) => Math.floor(PER_YEAR[f] / 12);

/**
 * A member's monthly income.
 * Fixed mode: usual paycheck converted to monthly.
 * Per-paycheck mode: the average of the latest month's worth of logged checks × paychecks per year ÷ 12
 * (automatic and by paycheck both), or the usual paycheck until that many are logged.
 * Checks dated after `today` are ignored until their date arrives.
 */
export function monthlyIncome(member: Member, paychecks: Paycheck[], today: ISODate): IncomeResult {
  const fixed = monthlyFromPaycheck(member.pay_amount_cents, member.pay_frequency);
  if (member.income_mode === 'fixed') return { monthlyCents: fixed, source: 'fixed', paychecksUsed: 0 };

  const n = paychecksNeeded(member.pay_frequency);
  const logged = paychecks
    .filter((p) => p.member_id === member.user_id && p.paid_on <= today)
    .sort((a, b) => b.paid_on.localeCompare(a.paid_on));
  if (logged.length < n) return { monthlyCents: fixed, source: 'fallback', paychecksUsed: logged.length };
  const total = logged.slice(0, n).reduce((s, p) => s + p.amount_cents, 0);
  return {
    monthlyCents: monthlyFromPaycheck(total / n, member.pay_frequency),
    source: member.paycheck_average === 'per_paycheck' ? 'per_paycheck' : 'auto',
    paychecksUsed: n,
  };
}

/**
 * A member's paydays between `from` and `to` (both inclusive), worked out from their one saved payday.
 * Empty if they haven't saved one.
 */
export function paydays(member: Pick<Member, 'payday' | 'pay_frequency'>, from: ISODate, to: ISODate): ISODate[] {
  const p = member.payday;
  if (!p) return [];
  // dueDates never goes before its start, so start a year early: a payday saved for next week still counts back.
  if (member.pay_frequency === 'weekly' || member.pay_frequency === 'biweekly') {
    return dueDates({ recurrence: member.pay_frequency, start_date: addDays(p, -364) }, from, to);
  }
  const monthly = (start: ISODate) => dueDates({ recurrence: 'monthly', start_date: addMonths(start, -12) }, from, to);
  if (member.pay_frequency === 'monthly') return monthly(p);
  // shortcut: twice a month = the saved day and 15 days later; "15th and last day" schedules drift by a day or two, upgrade if someone needs exact dates.
  return [...monthly(p), ...monthly(addDays(p, 15))].sort();
}
