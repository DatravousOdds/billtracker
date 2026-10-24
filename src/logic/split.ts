import type { Bill, Contribution, Household, ISODate, Member, Payment, Paycheck, WeeklyMode } from '../types';
import { addDays, weekStart } from './dates';
import { monthlyIncome, paydays, type IncomeResult } from './income';
import { splitByRatio } from './money';
import { dueDates, monthlyEquivalent } from './recurrence';

export interface Share {
  member: Member;
  income: IncomeResult;
  /** 0..1 */
  ratio: number;
}

/**
 * Each partner's share of the combined income, or the split both partners agreed on.
 * Falls back to an even split if nobody has income entered.
 */
export function incomeShares(
  members: Member[],
  paychecks: Paycheck[],
  today: ISODate,
  split?: Pick<Household, 'split_member' | 'split_percent'>,
): Share[] {
  const incomes = members.map((m) => monthlyIncome(m, paychecks, today));
  const total = incomes.reduce((s, i) => s + i.monthlyCents, 0);
  // Only while both partners (including the one it names) are still in the household.
  const agreed = members.length === 2 && split?.split_percent != null
    && members.some((m) => m.user_id === split.split_member) ? split.split_percent / 100 : null;
  return members.map((member, i) => ({
    member,
    income: incomes[i],
    ratio: agreed !== null ? (member.user_id === split!.split_member ? agreed : 1 - agreed)
      : total > 0 ? incomes[i].monthlyCents / total : 1 / members.length,
  }));
}

export interface Occurrence {
  bill: Bill;
  date: ISODate;
  payment: Payment | undefined;
}

/** Every due date of every active bill in a date range, oldest first, with its payment if paid. */
export function occurrences(bills: Bill[], payments: Payment[], from: ISODate, to: ISODate): Occurrence[] {
  const paid = new Map(payments.map((p) => [`${p.bill_id}|${p.due_date}`, p]));
  const out: Occurrence[] = [];
  for (const bill of bills) {
    if (!bill.active) continue;
    for (const date of dueDates(bill, from, to)) {
      out.push({ bill, date, payment: paid.get(`${bill.id}|${date}`) });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.bill.name.localeCompare(b.bill.name));
}

/**
 * Bills due today or earlier (up to 60 days back) that nobody has confirmed paid yet.
 * Autopay bills are left out. A bill added with a past due date counts as unpaid from that date.
 */
export function needsConfirming(bills: Bill[], payments: Payment[], today: ISODate): Occurrence[] {
  return occurrences(bills, payments, addDays(today, -60), today)
    .filter((o) => !o.payment && !o.bill.autopay);
}

/** Average shared bills per month (cents). Personal and paused bills are left out. */
export function monthlySharedTotal(bills: Bill[]): number {
  return bills
    .filter((b) => b.active && b.owner_id === null)
    .reduce((s, b) => s + monthlyEquivalent(b), 0);
}

export interface WeekPlan {
  weekStart: ISODate;
  weekEnd: ISODate;
  mode: WeeklyMode;
  /** What the shared amount for the week is made of. */
  regularCents: number; // smoothed: recurring bills averaged per week
  oneTimeCents: number; // smoothed: one-time shared bills due this week
  sharedTotalCents: number;
  perMember: { member: Member; ratio: number; sharedCents: number; personalCents: number }[];
  dueThisWeek: Occurrence[];
}

/**
 * What each partner owes for the week containing `date`.
 *
 * smoothed: (average monthly shared bills × 12 ÷ 52) every week, plus any one-time
 *           shared bills due this week, split by income.
 * due:      the unpaid shared bills due this week plus, when `overdue` is on, unpaid shared
 *           bills from before it (same rule as needsConfirming), split by income.
 *
 * Personal bills are never split; they're shown separately for their owner.
 */
export function weekPlan(
  date: ISODate,
  mode: WeeklyMode,
  bills: Bill[],
  payments: Payment[],
  shares: Share[],
  overdue = true,
): WeekPlan {
  const start = weekStart(date);
  const end = addDays(start, 6);
  const due = occurrences(bills, payments, start, end);
  const sharedDue = due.filter((o) => o.bill.owner_id === null);

  let regular = 0;
  let oneTime = 0;
  if (mode === 'smoothed') {
    regular = Math.round((monthlySharedTotal(bills) * 12) / 52);
    oneTime = sharedDue.filter((o) => o.bill.recurrence === 'once').reduce((s, o) => s + o.bill.amount_cents, 0);
  } else {
    const late = overdue ? needsConfirming(bills, payments, addDays(start, -1)) : [];
    regular = [...sharedDue, ...late]
      .filter((o) => o.bill.owner_id === null && !o.payment)
      .reduce((s, o) => s + o.bill.amount_cents, 0);
  }
  const total = regular + oneTime;
  const parts = splitByRatio(total, shares.map((s) => s.ratio));

  return {
    weekStart: start,
    weekEnd: end,
    mode,
    regularCents: regular,
    oneTimeCents: oneTime,
    sharedTotalCents: total,
    dueThisWeek: due,
    perMember: shares.map((s, i) => ({
      member: s.member,
      ratio: s.ratio,
      sharedCents: parts[i],
      personalCents: due
        .filter((o) => o.bill.owner_id === s.member.user_id)
        .reduce((sum, o) => sum + o.bill.amount_cents, 0),
    })),
  };
}

export interface DepositDue {
  cents: number;
  /** How many weeks of their share this deposit covers (0 in a week without a payday). */
  weeks: number;
  /** First day covered: the day after payday when paying as due, else the start of this week. */
  from: ISODate;
  /** Last day covered: the next payday when paying as due, else the end of the last week. */
  to: ISODate;
  /** Pay as due: unpaid bills due on or before payday, asked for once on top of the weeks. */
  overdueCents: number;
  /** Their share for each covered week, in order. */
  weekCents: number[];
  /** Set in a week without a payday: when they're next paid. */
  nextPayday: ISODate | null;
  /** Set in a week without a payday they deposited for: the paycheck that already covers it. */
  lastPayday: ISODate | null;
}

/**
 * What a partner should deposit in the week containing `date`.
 * Without a saved payday it's this week's share. With one, nothing is asked in weeks
 * without a payday. A payday week covers it and every week until the next payday week (smoothed),
 * or, paying as due, the bills due from the day after payday through the next payday, in 7-day
 * chunks (that day's pay may land after its bills), plus anything still unpaid by payday as overdue.
 */
export function depositDue(
  member: Member,
  date: ISODate,
  mode: WeeklyMode,
  bills: Bill[],
  payments: Payment[],
  shares: Share[],
  contributions: Contribution[],
): DepositDue {
  // Overdue bills belong to the first week only, or a multi-week deposit would count them again.
  const share = (d: ISODate, overdue = true) =>
    weekPlan(d, mode, bills, payments, shares, overdue).perMember.find((p) => p.member.user_id === member.user_id)?.sharedCents ?? 0;
  const start = weekStart(date);
  const end = addDays(start, 6);
  const cents = share(start);
  const weekly = { cents, weeks: 1, from: start, to: end, overdueCents: 0, weekCents: [cents], nextPayday: null, lastPayday: null };
  if (!member.payday) return weekly;
  const pay = paydays(member, start, end)[0];
  if (!pay) {
    const next = paydays(member, addDays(end, 1), addDays(end, 62))[0];
    // Did they deposit on their last payday? That deposit covers this week.
    const last = paydays(member, addDays(start, -62), addDays(start, -1)).at(-1) ?? null;
    const depositedLast = !!last && contributions.some((c) => c.member_id === member.user_id && c.week_start === weekStart(last));
    // Every schedule pays within 62 days; no payday means a bad saved date, so keep asking weekly.
    return next ? { cents: 0, weeks: 0, from: start, to: end, overdueCents: 0, weekCents: [], nextPayday: next, lastPayday: depositedLast ? last : null } : weekly;
  }
  // Overdue bills are asked for once, now.
  let overdueCents = cents - share(start, false);
  let weekCents: number[] = [];
  let from = start;
  let to: ISODate;
  if (mode === 'due') {
    // Pay as due: the day after payday through the next payday, in 7-day chunks; unpaid by payday is overdue.
    const i = shares.findIndex((s) => s.member.user_id === member.user_id);
    const mine = (occ: Occurrence[]) => i < 0 ? 0 : splitByRatio(
      occ.filter((o) => o.bill.owner_id === null && !o.payment).reduce((s, o) => s + o.bill.amount_cents, 0),
      shares.map((s) => s.ratio),
    )[i];
    from = addDays(pay, 1);
    to = paydays(member, from, addDays(pay, 62))[0] ?? addDays(pay, 7);
    overdueCents = mine(needsConfirming(bills, payments, pay));
    for (let d = from; d <= to; d = addDays(d, 7)) {
      weekCents.push(mine(occurrences(bills, payments, d, addDays(d, 6) < to ? addDays(d, 6) : to)));
    }
  } else {
    // Smoothed: this week up to the next payday week (at most 6 weeks; monthly pay is the longest gap).
    let weeks = 1;
    while (weeks < 6 && !paydays(member, addDays(start, 7 * weeks), addDays(start, 7 * weeks + 6)).length) weeks++;
    weekCents = Array.from({ length: weeks }, (_, w) => share(addDays(start, 7 * w), false));
    to = addDays(start, 7 * weeks - 1);
  }
  return {
    cents: overdueCents + weekCents.reduce((s, c) => s + c, 0),
    weeks: weekCents.length, from, to, overdueCents, weekCents, nextPayday: null, lastPayday: null,
  };
}

export interface Leftover {
  member: Member;
  incomeCents: number;
  sharedCents: number; // their split of shared bills due in the period
  personalCents: number; // their own bills due in the period
  leftCents: number; // can be negative
}

/**
 * What each partner has left from a period's income after the bills actually due in it
 * (paid or not; a paid bill counts at the amount actually paid).
 * Month income for someone who logs paychecks is the checks dated in that month (including
 * ones logged ahead of time), so a mid-month start counts only what was actually paid.
 * Everyone else, and a month with nothing logged yet, uses the average month.
 */
export function leftover(
  bills: Bill[],
  payments: Payment[],
  shares: Share[],
  from: ISODate,
  to: ISODate,
  period: 'week' | 'month',
  paychecks: Paycheck[] = [],
): Leftover[] {
  const due = occurrences(bills, payments, from, to);
  const cost = (o: Occurrence) => o.payment?.amount_cents ?? o.bill.amount_cents;
  const sharedTotal = due.filter((o) => o.bill.owner_id === null).reduce((s, o) => s + cost(o), 0);
  const parts = splitByRatio(sharedTotal, shares.map((s) => s.ratio));
  return shares.map((s, i) => {
    const { monthlyCents } = s.income;
    const logged = paychecks.filter((p) => p.member_id === s.member.user_id && p.paid_on >= from && p.paid_on <= to);
    const incomeCents = period === 'week' ? Math.round((monthlyCents * 12) / 52)
      : s.member.income_mode !== 'fixed' && logged.length ? logged.reduce((sum, p) => sum + p.amount_cents, 0)
      : Math.round(monthlyCents);
    const personalCents = due
      .filter((o) => o.bill.owner_id === s.member.user_id)
      .reduce((sum, o) => sum + cost(o), 0);
    return {
      member: s.member,
      incomeCents,
      sharedCents: parts[i],
      personalCents,
      leftCents: incomeCents - parts[i] - personalCents,
    };
  });
}

export interface Balance {
  member: Member;
  putInCents: number; // contributions + shared bills they paid directly
  fairShareCents: number; // their income share of everything both of you put in
  balanceCents: number; // positive = has covered more than their share
}

export interface Ledger {
  balances: Balance[];
  /** Money put into the shared account minus shared bills paid from it. */
  accountCents: number;
}

/**
 * Who has covered more than their share so far.
 * Everything both partners put toward shared bills (account deposits + shared bills
 * paid directly) is added up; each partner "should" have put in their income share
 * of that total. The balances always add up to zero.
 * Uses the current income split for all history (a simple, predictable rule).
 */
export function ledger(
  bills: Bill[],
  payments: Payment[],
  contributions: Contribution[],
  shares: Share[],
): Ledger {
  const sharedBillIds = new Set(bills.filter((b) => b.owner_id === null).map((b) => b.id));
  const sharedPayments = payments.filter((p) => sharedBillIds.has(p.bill_id));

  const putIns = shares.map((s) => {
    const contributed = contributions
      .filter((c) => c.member_id === s.member.user_id)
      .reduce((sum, c) => sum + c.amount_cents, 0);
    const paidDirect = sharedPayments
      .filter((p) => p.paid_by === s.member.user_id)
      .reduce((sum, p) => sum + p.amount_cents, 0);
    return contributed + paidDirect;
  });
  const fair = splitByRatio(putIns.reduce((a, b) => a + b, 0), shares.map((s) => s.ratio));

  const balances = shares.map((s, i) => ({
    member: s.member,
    putInCents: putIns[i],
    fairShareCents: fair[i],
    balanceCents: putIns[i] - fair[i],
  }));

  const contributedTotal = contributions.reduce((s, c) => s + c.amount_cents, 0);
  const paidFromAccount = sharedPayments.filter((p) => p.paid_by === null).reduce((s, p) => s + p.amount_cents, 0);

  return { balances, accountCents: contributedTotal - paidFromAccount };
}
