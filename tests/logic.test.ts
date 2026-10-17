import { describe, expect, it } from 'vitest';
import { addMonths, weekStart } from '../src/logic/dates';
import { monthlyFromPaycheck, monthlyIncome, paychecksNeeded } from '../src/logic/income';
import { parseDollars, splitByRatio } from '../src/logic/money';
import { dueDates } from '../src/logic/recurrence';
import { incomeShares, ledger, needsConfirming, weekPlan } from '../src/logic/split';
import type { Bill, Member, Paycheck } from '../src/types';

const member = (id: string, pay: number, freq: Member['pay_frequency'], mode: Member['income_mode'] = 'fixed'): Member => ({
  user_id: id, household_id: 'h', display_name: id, pay_amount_cents: pay, pay_frequency: freq,
  income_mode: mode, paycheck_average: 'auto', created_at: '',
});
const bill = (id: string, amount: number, recurrence: Bill['recurrence'], start: string, owner: string | null = null): Bill => ({
  id, household_id: 'h', name: id, amount_cents: amount, category: 'x', recurrence, start_date: start,
  autopay: false, owner_id: owner, active: true, created_at: '2025-01-01',
});

describe('money', () => {
  it('parses dollars to cents', () => {
    expect(parseDollars('$1,234.5')).toBe(123450);
    expect(parseDollars('12')).toBe(1200);
    expect(parseDollars('0.07')).toBe(7);
    expect(parseDollars('abc')).toBeNull();
    expect(parseDollars('1.234')).toBeNull();
  });
  it('splits so parts always add up', () => {
    expect(splitByRatio(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(splitByRatio(80000, [0.615, 0.385])).toEqual([49200, 30800]);
    const parts = splitByRatio(12345, [4000, 2500]);
    expect(parts[0] + parts[1]).toBe(12345);
    expect(splitByRatio(100, [0, 0])).toEqual([50, 50]);
  });
});

describe('dates', () => {
  it('clamps month-end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
  });
  it('weeks start on Sunday', () => {
    expect(weekStart('2026-10-11')).toBe('2026-10-11'); // a Sunday
    expect(weekStart('2026-10-17')).toBe('2026-10-11');
    expect(weekStart('2026-10-18')).toBe('2026-10-18');
  });
});

describe('recurrence', () => {
  it('monthly keeps day 31 across short months', () => {
    expect(dueDates({ recurrence: 'monthly', start_date: '2026-01-31' }, '2026-01-01', '2026-05-31'))
      .toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  });
  it('biweekly jumps to the window', () => {
    expect(dueDates({ recurrence: 'biweekly', start_date: '2026-01-02' }, '2026-10-01', '2026-10-31'))
      .toEqual(['2026-10-09', '2026-10-23']);
  });
  it('quarterly / yearly / once', () => {
    expect(dueDates({ recurrence: 'quarterly', start_date: '2025-11-15' }, '2026-01-01', '2026-12-31'))
      .toEqual(['2026-02-15', '2026-05-15', '2026-08-15', '2026-11-15']);
    expect(dueDates({ recurrence: 'yearly', start_date: '2024-03-01' }, '2026-01-01', '2026-12-31')).toEqual(['2026-03-01']);
    expect(dueDates({ recurrence: 'once', start_date: '2026-10-12' }, '2026-10-11', '2026-10-17')).toEqual(['2026-10-12']);
    expect(dueDates({ recurrence: 'monthly', start_date: '2026-12-01' }, '2026-10-01', '2026-10-31')).toEqual([]);
  });
});

describe('income', () => {
  it('converts every schedule to the same monthly figure', () => {
    expect(monthlyFromPaycheck(100000, 'weekly')).toBeCloseTo(433333.33, 1);
    expect(monthlyFromPaycheck(200000, 'biweekly')).toBeCloseTo(433333.33, 1);
    expect(monthlyFromPaycheck(216650, 'semimonthly')).toBe(433300);
  });
  it('needs one month of paychecks for the schedule', () => {
    expect(['weekly', 'biweekly', 'semimonthly', 'monthly'].map((f) => paychecksNeeded(f as Member['pay_frequency'])))
      .toEqual([4, 2, 2, 1]);
  });
  it('per-paycheck uses the latest month of checks, automatic or by paycheck', () => {
    const m = member('a', 200000, 'biweekly', 'per_paycheck');
    const checks: Paycheck[] = [
      { id: '1', household_id: 'h', member_id: 'a', amount_cents: 100000, paid_on: '2026-10-01' },
      { id: '2', household_id: 'h', member_id: 'a', amount_cents: 999999, paid_on: '2026-09-03' }, // older than the latest 2
      { id: '3', household_id: 'h', member_id: 'a', amount_cents: 110000, paid_on: '2026-10-15' },
      { id: '4', household_id: 'h', member_id: 'b', amount_cents: 999999, paid_on: '2026-10-16' }, // other member
    ];
    const auto = monthlyIncome(m, checks);
    expect(auto.source).toBe('auto');
    expect(auto.paychecksUsed).toBe(2);
    expect(auto.monthlyCents).toBe(210000); // 1100 + 1000
    const per = monthlyIncome({ ...m, paycheck_average: 'per_paycheck' }, checks);
    expect(per.source).toBe('per_paycheck');
    expect(per.monthlyCents).toBe(227500); // avg 1050 × 26 ÷ 12
  });
  it('falls back to the usual paycheck until enough are logged', () => {
    const m = member('a', 100000, 'weekly', 'per_paycheck');
    const three: Paycheck[] = [1, 2, 3].map((d) => ({ id: `${d}`, household_id: 'h', member_id: 'a', amount_cents: 50000, paid_on: `2026-10-0${d}` }));
    const r = monthlyIncome(m, three);
    expect(r.source).toBe('fallback');
    expect(r.paychecksUsed).toBe(3);
    expect(r.monthlyCents).toBe(monthlyFromPaycheck(100000, 'weekly'));
  });
});

describe('split', () => {
  const a = member('a', 400000, 'monthly');
  const b = member('b', 250000, 'monthly');
  const shares = incomeShares([a, b], []);

  it('income shares', () => {
    expect(shares[0].ratio).toBeCloseTo(0.6154, 3);
  });

  it('smoothed week: monthly total × 12 ÷ 52, personal bills separate', () => {
    const bills = [
      bill('rent', 130000, 'monthly', '2026-01-01'),
      bill('car', 40000, 'monthly', '2026-01-13', 'b'), // personal
      bill('repair', 26000, 'once', '2026-10-14'),
    ];
    const plan = weekPlan('2026-10-13', 'smoothed', bills, [], shares);
    expect(plan.regularCents).toBe(30000); // 1300 × 12 ÷ 52
    expect(plan.oneTimeCents).toBe(26000);
    expect(plan.perMember[0].sharedCents + plan.perMember[1].sharedCents).toBe(56000);
    expect(plan.perMember[1].personalCents).toBe(40000);
    expect(plan.perMember[0].personalCents).toBe(0);
  });

  it('due week: only what is due', () => {
    const bills = [bill('rent', 130000, 'monthly', '2026-01-01'), bill('phone', 8000, 'monthly', '2026-01-15')];
    const plan = weekPlan('2026-10-13', 'due', bills, [], shares);
    expect(plan.sharedTotalCents).toBe(8000);
  });

  it('ledger balances add up to zero', () => {
    const bills = [bill('rent', 130000, 'monthly', '2026-01-01')];
    const l = ledger(
      bills,
      [{ id: 'p', household_id: 'h', bill_id: 'rent', due_date: '2026-10-01', paid_on: '2026-10-01', amount_cents: 130000, paid_by: 'a' }],
      [{ id: 'c', household_id: 'h', member_id: 'b', week_start: '2026-10-04', amount_cents: 10000 }],
      shares,
    );
    expect(l.balances[0].balanceCents + l.balances[1].balanceCents).toBe(0);
    expect(l.balances[0].balanceCents).toBeGreaterThan(0); // a paid all of rent
    expect(l.accountCents).toBe(10000);
  });

  it('needs confirming: unpaid bills due today or earlier, skipping autopay and paid ones', () => {
    const bills = [
      bill('rent', 130000, 'monthly', '2026-01-01'),
      bill('phone', 8000, 'monthly', '2026-01-11'),
      bill('water', 6000, 'monthly', '2026-01-12'), // Oct 12 is tomorrow, so not yet
      { ...bill('internet', 7000, 'monthly', '2026-01-05'), autopay: true },
    ];
    const paid = [{ id: 'p', household_id: 'h', bill_id: 'rent', due_date: '2026-10-01', paid_on: '2026-10-01', amount_cents: 130000, paid_by: null }];
    const list = needsConfirming(bills, paid, '2026-10-11');
    expect(list.map((o) => `${o.bill.id} ${o.date}`)).toEqual([
      'water 2026-08-12', 'rent 2026-09-01', 'phone 2026-09-11', 'water 2026-09-12', 'phone 2026-10-11',
    ]);
  });
});
