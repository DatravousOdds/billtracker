import { describe, expect, it } from 'vitest';
import { addMonths, weekStart } from '../src/logic/dates';
import { monthlyFromPaycheck, monthlyIncome, paychecksNeeded, paydays } from '../src/logic/income';
import { parseDollars, splitByRatio } from '../src/logic/money';
import { dueDates, groupByCategory, sortByNextDue } from '../src/logic/recurrence';
import { depositDue, incomeShares, ledger, leftover, needsConfirming, weekPlan } from '../src/logic/split';
import type { Bill, Member, Paycheck } from '../src/types';

const member = (id: string, pay: number, freq: Member['pay_frequency'], mode: Member['income_mode'] = 'fixed'): Member => ({
  user_id: id, household_id: 'h', display_name: id, pay_amount_cents: pay, pay_frequency: freq,
  income_mode: mode, paycheck_average: 'auto', payday: null, created_at: '',
});
const bill = (id: string, amount: number, recurrence: Bill['recurrence'], start: string, owner: string | null = null): Bill => ({
  id, household_id: 'h', name: id, amount_cents: amount, category: 'x', recurrence, start_date: start,
  autopay: false, owner_id: owner, active: true, created_at: '2025-01-01',
});
const deposit = (memberId: string, week_start: string) => ({ id: week_start, household_id: 'h', member_id: memberId, week_start, amount_cents: 1 });

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
  it('ignores start dates without a 4-digit year instead of looping', () => {
    expect(dueDates({ recurrence: 'monthly', start_date: '10000-01-01' }, '2026-08-19', '2026-10-17')).toEqual([]);
    expect(dueDates({ recurrence: 'weekly', start_date: '' }, '2026-08-19', '2026-10-17')).toEqual([]);
  });
  it('sorts bills by next due date, with no-upcoming-date bills last', () => {
    const bills = [
      bill('rent', 1, 'monthly', '2026-01-01'),   // next 2026-11-01
      bill('done', 1, 'once', '2026-09-01'),      // already past
      bill('phone', 1, 'monthly', '2026-01-25'),  // next 2026-10-25
      bill('car', 1, 'yearly', '2025-03-10'),     // next 2027-03-10
    ];
    const names = (desc: boolean) => sortByNextDue(bills, '2026-10-18', desc).map((b) => b.id);
    expect(names(true)).toEqual(['car', 'rent', 'phone', 'done']);
    expect(names(false)).toEqual(['phone', 'rent', 'car', 'done']);
  });
  it('groups bills by category in order of each group\'s first bill', () => {
    const bills = [
      { id: 'dental', category: 'Loans' },
      { id: 'phone', category: 'Utilities' },
      { id: 'upstart', category: 'loans' },
    ];
    expect(groupByCategory(bills).map(([c, list]) => [c, list.map((b) => b.id)]))
      .toEqual([['Loans', ['dental', 'upstart']], ['Utilities', ['phone']]]);
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
  it('per-paycheck averages the latest month of checks, automatic or by paycheck', () => {
    const m = member('a', 200000, 'biweekly', 'per_paycheck');
    const checks: Paycheck[] = [
      { id: '1', household_id: 'h', member_id: 'a', amount_cents: 100000, paid_on: '2026-10-01' },
      { id: '2', household_id: 'h', member_id: 'a', amount_cents: 999999, paid_on: '2026-09-03' }, // older than the latest 2
      { id: '3', household_id: 'h', member_id: 'a', amount_cents: 110000, paid_on: '2026-10-15' },
      { id: '4', household_id: 'h', member_id: 'b', amount_cents: 999999, paid_on: '2026-10-16' }, // other member
      { id: '5', household_id: 'h', member_id: 'a', amount_cents: 999999, paid_on: '2026-10-29' }, // future: not paid yet
    ];
    const auto = monthlyIncome(m, checks, '2026-10-17');
    expect(auto.source).toBe('auto');
    expect(auto.paychecksUsed).toBe(2);
    expect(auto.monthlyCents).toBe(227500); // avg 1050 × 26 ÷ 12
    const per = monthlyIncome({ ...m, paycheck_average: 'per_paycheck' }, checks, '2026-10-17');
    expect(per.source).toBe('per_paycheck');
    expect(per.monthlyCents).toBe(227500); // avg 1050 × 26 ÷ 12
  });
  it('falls back to the usual paycheck until enough are logged', () => {
    const m = member('a', 100000, 'weekly', 'per_paycheck');
    const three: Paycheck[] = [1, 2, 3].map((d) => ({ id: `${d}`, household_id: 'h', member_id: 'a', amount_cents: 50000, paid_on: `2026-10-0${d}` }));
    const r = monthlyIncome(m, three, '2026-10-17');
    expect(r.source).toBe('fallback');
    expect(r.paychecksUsed).toBe(3);
    expect(r.monthlyCents).toBe(monthlyFromPaycheck(100000, 'weekly'));
  });
});

describe('paydays', () => {
  it('counts back from a payday saved in the future', () => {
    expect(paydays({ payday: '2026-10-23', pay_frequency: 'biweekly' }, '2026-10-01', '2026-10-31'))
      .toEqual(['2026-10-09', '2026-10-23']);
  });
  it('monthly on the 31st falls back to the end of short months', () => {
    expect(paydays({ payday: '2026-01-31', pay_frequency: 'monthly' }, '2026-02-01', '2026-03-31'))
      .toEqual(['2026-02-28', '2026-03-31']);
  });
  it('twice a month gives two paydays a month', () => {
    expect(paydays({ payday: '2026-10-01', pay_frequency: 'semimonthly' }, '2026-11-01', '2026-11-30'))
      .toEqual(['2026-11-01', '2026-11-16']);
  });
  it('none without a saved payday', () => {
    expect(paydays({ payday: null, pay_frequency: 'weekly' }, '2026-10-01', '2026-10-31')).toEqual([]);
  });
});

describe('split', () => {
  const a = member('a', 400000, 'monthly');
  const b = member('b', 250000, 'monthly');
  const shares = incomeShares([a, b], [], '2026-10-11');

  it('income shares', () => {
    expect(shares[0].ratio).toBeCloseTo(0.6154, 3);
  });

  it('an agreed split overrides income, but only with both partners still there', () => {
    const agreed = incomeShares([a, b], [], '2026-10-11', { split_member: 'b', split_percent: 70 });
    expect(agreed.map((x) => x.ratio)).toEqual([expect.closeTo(0.3), 0.7]);
    expect(agreed[0].income.monthlyCents).toBe(400000); // income itself is unchanged
    expect(incomeShares([a], [], '2026-10-11', { split_member: 'b', split_percent: 70 })[0].ratio).toBe(1);
    expect(incomeShares([a, b], [], '2026-10-11', { split_member: 'gone', split_percent: 70 })[0].ratio).toBeCloseTo(0.6154, 3);
    expect(incomeShares([a, b], [], '2026-10-11', { split_member: null, split_percent: null })[0].ratio).toBeCloseTo(0.6154, 3);
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

  it('smoothed: deposit is asked for only in payday weeks, covering the weeks until the next one', () => {
    const bills = [bill('rent', 130000, 'monthly', '2026-01-01')];
    const weekly = weekPlan('2026-10-13', 'smoothed', bills, [], shares).perMember[1].sharedCents;
    const due = (m: Member, date: string, deposits = [deposit(b.user_id, '2026-10-04')]) => depositDue(m, date, 'smoothed', bills, [], shares, deposits);
    const biweekly = { ...b, pay_frequency: 'biweekly' as const, payday: '2026-10-23' };
    // Week of Oct 11–17 is covered by the Oct 9 pay; Oct 23 covers Oct 18–31; Oct 25–31 is already covered.
    expect(due(biweekly, '2026-10-13')).toEqual({ cents: 0, weeks: 0, from: '2026-10-11', to: '2026-10-17', overdueCents: 0, weekCents: [], nextPayday: '2026-10-23', lastPayday: '2026-10-09' });
    expect(due(biweekly, '2026-10-20')).toEqual({ cents: weekly * 2, weeks: 2, from: '2026-10-18', to: '2026-10-31', overdueCents: 0, weekCents: [weekly, weekly], nextPayday: null, lastPayday: null });
    expect(due(biweekly, '2026-10-27')).toMatchObject({ cents: 0, weeks: 0, nextPayday: '2026-11-06' });
    // Says which paycheck covers the week only when they deposited from it.
    expect(due(biweekly, '2026-10-13', [])).toMatchObject({ cents: 0, lastPayday: null });
    // Paid Oct 1 (week of Sep 27); next payday Nov 1 starts its own week, so 5 weeks are covered.
    expect(due({ ...b, payday: '2026-10-01' }, '2026-10-01')).toMatchObject({ cents: weekly * 5, weeks: 5, from: '2026-09-27' });
    // Twice a month on the 1st and 16th: the Oct 1 week covers 2 weeks, the Oct 16 week covers 3 (until the Nov 1 week).
    const semi = { ...b, pay_frequency: 'semimonthly' as const, payday: '2026-10-01' };
    expect(due(semi, '2026-10-01')).toMatchObject({ cents: weekly * 2, weeks: 2, from: '2026-09-27' });
    expect(due(semi, '2026-10-16')).toMatchObject({ cents: weekly * 3, weeks: 3, from: '2026-10-11' });
    expect(due({ ...b, pay_frequency: 'weekly', payday: '2026-10-23' }, '2026-10-20')).toMatchObject({ cents: weekly, weeks: 1, from: '2026-10-18' });
    // No payday saved: this week's share.
    expect(due(b, '2026-10-13')).toMatchObject({ cents: weekly, weeks: 1, from: '2026-10-11' });
    // A payday saved too far ahead to project falls back to asking every week.
    expect(due({ ...biweekly, payday: '2028-03-03' }, '2026-10-13')).toMatchObject({ cents: weekly, weeks: 1, from: '2026-10-11' });
  });

  it('pay as due: a payday deposit covers the day after payday through the next payday', () => {
    // Phone due the 22nd, water the 23rd, internet the 28th, rent the 1st, gym the 6th.
    const bills = [
      bill('phone', 8000, 'monthly', '2026-10-22'), bill('water', 4000, 'monthly', '2026-10-23'), bill('internet', 6000, 'monthly', '2026-10-28'),
      bill('rent', 130000, 'monthly', '2026-11-01'), bill('gym', 3000, 'monthly', '2026-11-06'),
    ];
    const mine = (c: number) => splitByRatio(c, shares.map((s) => s.ratio))[1];
    const due = (m: Member, date: string, deposits: string[] = []) =>
      depositDue(m, date, 'due', bills, [], shares, deposits.map((w) => deposit(b.user_id, w)));
    const paid = (bill_id: string, due_date: string) => ({ id: bill_id, household_id: 'h', bill_id, due_date, paid_on: due_date, amount_cents: 1, paid_by: null });
    // Every 2 weeks, paid Oct 23 and Nov 6: Oct 23 covers Oct 24 – Nov 6 (internet; rent and the gym due on the next payday).
    // The phone (22nd) and water (payday) are still unpaid, so they're overdue.
    const biweekly = { ...b, pay_frequency: 'biweekly' as const, payday: '2026-11-06' };
    const oct23 = {
      cents: mine(12000) + mine(6000) + mine(133000), weeks: 2, from: '2026-10-24', to: '2026-11-06',
      overdueCents: mine(12000), weekCents: [mine(6000), mine(133000)],
    };
    expect(due(biweekly, '2026-10-24')).toMatchObject(oct23);
    // Same whether or not they deposited on their last payday.
    expect(due(biweekly, '2026-10-24', ['2026-10-04'])).toMatchObject(oct23);
    // Paid bills are left out, overdue or not.
    expect(depositDue(biweekly, '2026-10-24', 'due', bills, [paid('water', '2026-10-23'), paid('internet', '2026-10-28')], shares, []))
      .toMatchObject({ overdueCents: mine(8000), weekCents: [0, mine(133000)] });
    // The week between paydays: nothing due, covered by the Oct 23 pay only if they deposited from it.
    expect(due(biweekly, '2026-10-27', ['2026-10-18'])).toMatchObject({ cents: 0, weeks: 0, nextPayday: '2026-11-06', lastPayday: '2026-10-23' });
    expect(due(biweekly, '2026-10-27')).toMatchObject({ cents: 0, weeks: 0, lastPayday: null });
    // Paid weekly on Fridays: each deposit covers Saturday through the next Friday.
    expect(due({ ...b, pay_frequency: 'weekly', payday: '2026-11-20' }, '2026-11-17')).toMatchObject({ weeks: 1, from: '2026-11-21', to: '2026-11-27' });
    // Paid monthly on the 1st: Dec 1 covers Dec 2 – Jan 1, the last chunk only Dec 30 – Jan 1 (January rent).
    expect(due({ ...b, pay_frequency: 'monthly', payday: '2026-11-01' }, '2026-12-01')).toMatchObject({
      weeks: 5, from: '2026-12-02', to: '2027-01-01', weekCents: [mine(3000), 0, mine(8000), mine(10000), mine(130000)],
    });
  });

  it('due week: unpaid bills due this week plus unpaid overdue ones, never paid or autopay', () => {
    const bills = [
      bill('repair', 26000, 'once', '2026-10-02'), // overdue and unpaid
      bill('phone', 8000, 'monthly', '2026-10-15'), // due this week
      bill('water', 6000, 'monthly', '2026-10-12'), // due this week, paid
      { ...bill('internet', 7000, 'monthly', '2026-10-05'), autopay: true }, // overdue but autopay
      bill('car', 40000, 'monthly', '2026-10-14', 'b'), // personal, never in the shared total
    ];
    const paid = [{ id: 'p', household_id: 'h', bill_id: 'water', due_date: '2026-10-12', paid_on: '2026-10-12', amount_cents: 6000, paid_by: null }];
    expect(weekPlan('2026-10-13', 'due', bills, paid, shares).sharedTotalCents).toBe(34000);
    expect(weekPlan('2026-10-13', 'due', bills, paid, shares, false).sharedTotalCents).toBe(8000);
    // A payday deposit asks once for what's unpaid by the Oct 16 payday (repair, phone), on top of Oct 17–30 (nothing due).
    const biweekly = { ...b, pay_frequency: 'biweekly' as const, payday: '2026-10-16' };
    const overdue = splitByRatio(34000, shares.map((s) => s.ratio))[1];
    expect(depositDue(biweekly, '2026-10-13', 'due', bills, paid, shares, [])).toMatchObject({
      cents: overdue, overdueCents: overdue, weeks: 2, from: '2026-10-17', to: '2026-10-30',
    });
  });

  it('leftover: month income minus split shared bills and own personal bills', () => {
    const bills = [
      bill('rent', 130000, 'monthly', '2026-01-01'),
      bill('car', 40000, 'monthly', '2026-01-13', 'b'),
      { ...bill('gym', 5000, 'monthly', '2026-01-05'), active: false },
    ];
    const [la, lb] = leftover(bills, [], shares, '2026-10-01', '2026-10-31', 'month');
    expect(la.sharedCents + lb.sharedCents).toBe(130000); // paused gym left out
    expect(la.personalCents).toBe(0);
    expect(lb.personalCents).toBe(40000);
    expect(la.leftCents).toBe(400000 - la.sharedCents);
    expect(lb.leftCents).toBe(250000 - lb.sharedCents - 40000);
  });

  it('leftover: week prorates income and only counts bills due that week, can go negative', () => {
    const bills = [bill('rent', 130000, 'monthly', '2026-01-01'), bill('repair', 300000, 'once', '2026-10-14')];
    const [la, lb] = leftover(bills, [], shares, '2026-10-11', '2026-10-17', 'week');
    expect(la.incomeCents).toBe(92308); // 4000 × 12 ÷ 52
    expect(la.sharedCents + lb.sharedCents).toBe(300000); // rent is Oct 1, not this week
    expect(la.leftCents).toBeLessThan(0);
  });

  it('leftover: automatic averaging gives a weekly earner their average check per week', () => {
    const sam = member('s', 0, 'weekly', 'per_paycheck');
    const checks = [65000, 61250, 70500, 65000].map((amount_cents, i) => ({
      id: `p${i}`, household_id: 'h', member_id: 's', amount_cents, paid_on: `2026-10-0${i + 1}`,
    }));
    const sh = incomeShares([sam], checks, '2026-10-18');
    expect(sh[0].income.monthlyCents).toBe(283562.5); // avg 654.375 × 52 ÷ 12
    const [week] = leftover([], [], sh, '2026-10-18', '2026-10-24', 'week');
    expect(week.incomeCents).toBe(65438); // the average check, 654.375, rounded
  });

  it('leftover: month income is the logged checks dated in that month', () => {
    const tra = member('t', 104600, 'weekly', 'per_paycheck'); // started mid-month: 3 checks
    const les = member('l', 149800, 'biweekly', 'per_paycheck');
    const fix = member('f', 104600, 'weekly'); // fixed pay ignores logged checks
    const check = (member_id: string, paid_on: string, amount_cents: number) => ({ id: paid_on + member_id, household_id: 'h', member_id, amount_cents, paid_on });
    const checks = [
      check('t', '2026-10-16', 104600), check('t', '2026-10-23', 104600), check('t', '2026-10-30', 104600),
      check('l', '2026-09-25', 147600), check('l', '2026-10-09', 138200), check('l', '2026-10-23', 155000),
      check('f', '2026-10-16', 1),
    ];
    const sh = incomeShares([tra, les, fix], checks, '2026-10-21');
    const [t, l, f] = leftover([], [], sh, '2026-10-01', '2026-10-31', 'month', checks);
    expect(t.incomeCents).toBe(313800); // future-dated Oct 23 and 30 count
    expect(l.incomeCents).toBe(293200); // September check left out
    expect(f.incomeCents).toBe(453267); // 1046 × 52 ÷ 12
    const [nov] = leftover([], [], sh, '2026-11-01', '2026-11-30', 'month', checks);
    expect(nov.incomeCents).toBe(453267); // nothing logged yet: average month
  });

  it('leftover: a paid bill counts at the amount actually paid', () => {
    const bills = [bill('electric', 13500, 'monthly', '2026-01-18')];
    const paid = [{ id: 'p', household_id: 'h', bill_id: 'electric', due_date: '2026-10-18', paid_on: '2026-10-18', amount_cents: 14200, paid_by: null }];
    const [la, lb] = leftover(bills, paid, shares, '2026-10-01', '2026-10-31', 'month');
    expect(la.sharedCents + lb.sharedCents).toBe(14200);
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

  it('needs confirming: a bill added with a past due date is unpaid from that date', () => {
    const late = { ...bill('gas', 5000, 'monthly', '2026-09-10'), created_at: '2026-10-18T12:00:00Z' };
    expect(needsConfirming([late], [], '2026-10-18').map((o) => o.date)).toEqual(['2026-09-10', '2026-10-10']);
  });
});
