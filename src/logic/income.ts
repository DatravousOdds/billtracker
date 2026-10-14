import type { ISODate, Member, PayFrequency, Paycheck } from '../types';
import { addMonths } from './dates';

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
  /** 'fixed' = from the usual paycheck; 'logged' = rolling average; 'fallback' = per-paycheck mode but nothing logged yet. */
  source: 'fixed' | 'logged' | 'fallback';
  paychecksUsed: number;
}

/**
 * A member's monthly income.
 * Fixed mode: usual paycheck converted to monthly.
 * Per-paycheck mode: total of checks logged in the last `windowMonths` months ÷ windowMonths.
 */
export function monthlyIncome(
  member: Member,
  paychecks: Paycheck[],
  windowMonths: number,
  today: ISODate,
): IncomeResult {
  const fixed = monthlyFromPaycheck(member.pay_amount_cents, member.pay_frequency);
  if (member.income_mode === 'fixed') return { monthlyCents: fixed, source: 'fixed', paychecksUsed: 0 };

  const windowStart = addMonths(today, -windowMonths);
  const recent = paychecks.filter(
    (p) => p.member_id === member.user_id && p.paid_on > windowStart && p.paid_on <= today,
  );
  if (recent.length === 0) return { monthlyCents: fixed, source: 'fallback', paychecksUsed: 0 };
  const total = recent.reduce((s, p) => s + p.amount_cents, 0);
  return { monthlyCents: total / windowMonths, source: 'logged', paychecksUsed: recent.length };
}
