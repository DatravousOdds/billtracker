import type { AccountBalance, Bill, Contribution, Household, ISODate, Member, Payment, Paycheck, WeeklyMode } from '../types';
import { addDays, weekStart } from './dates';
import { monthlyIncome, paydays, PER_YEAR, type IncomeResult } from './income';
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

/** Past dates (today excluded) that would newly show as overdue if `before` became `after`. */
export function newlyOverdue(before: Bill, after: Bill, payments: Payment[], today: ISODate): number {
  const past = (b: Bill) => needsConfirming([b], payments, today).filter((o) => o.date < today).map((o) => o.date);
  const had = new Set(past(before));
  return past(after).filter((d) => !had.has(d)).length;
}

/** Average shared bills per month (cents). Personal and paused bills are left out. */
export function monthlySharedTotal(bills: Bill[]): number {
  return bills
    .filter((b) => b.active && b.owner_id === null)
    .reduce((s, b) => s + monthlyEquivalent(b), 0);
}

export interface WeekPlan {
  /** The period's first and last day (a Sun–Sat week from weekPlan). */
  weekStart: ISODate;
  weekEnd: ISODate;
  mode: WeeklyMode;
  /** What the shared amount for the week is made of. */
  regularCents: number; // smoothed: recurring bills averaged per week
  oneTimeCents: number; // smoothed: one-time shared bills due this week
  sharedTotalCents: number;
  /** due: the part of sharedTotalCents from unpaid bills before the period; 0 when smoothed. */
  overdueCents: number;
  perMember: { member: Member; ratio: number; sharedCents: number; personalCents: number }[];
  dueThisWeek: Occurrence[];
}

/** What each partner owes for the week containing `date`. See periodPlan. */
export function weekPlan(
  date: ISODate,
  mode: WeeklyMode,
  bills: Bill[],
  payments: Payment[],
  shares: Share[],
  overdue = true,
): WeekPlan {
  const s = weekStart(date);
  return periodPlan(s, addDays(s, 6), mode, bills, payments, shares, overdue);
}

/**
 * What each partner owes for the days `start` through `end`.
 *
 * smoothed: (average monthly shared bills × 12 ÷ 52) every week, plus any one-time
 *           shared bills due this week, split by income.
 * due:      the unpaid shared bills due in the period plus, when `overdue` is on, unpaid shared
 *           bills from before it (same rule as needsConfirming), split by income.
 *
 * Personal bills are never split; they're shown separately for their owner.
 */
export function periodPlan(
  start: ISODate,
  end: ISODate,
  mode: WeeklyMode,
  bills: Bill[],
  payments: Payment[],
  shares: Share[],
  overdue = true,
): WeekPlan {
  const due = occurrences(bills, payments, start, end);
  const sharedDue = due.filter((o) => o.bill.owner_id === null);

  let regular = 0;
  let oneTime = 0;
  let overdueCents = 0;
  if (mode === 'smoothed') {
    regular = Math.round((monthlySharedTotal(bills) * 12) / 52);
    oneTime = sharedDue.filter((o) => o.bill.recurrence === 'once').reduce((s, o) => s + o.bill.amount_cents, 0);
  } else {
    const unpaid = (occ: Occurrence[]) => occ
      .filter((o) => o.bill.owner_id === null && !o.payment)
      .reduce((s, o) => s + o.bill.amount_cents, 0);
    overdueCents = overdue ? unpaid(needsConfirming(bills, payments, addDays(start, -1))) : 0;
    regular = unpaid(sharedDue) + overdueCents;
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
    overdueCents,
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

/** The day after `member`'s last payday on or before `date`, through their next payday. */
export function payWindow(member: Pick<Member, 'payday' | 'pay_frequency'>, date: ISODate): { from: ISODate; to: ISODate } | null {
  const last = paydays(member, addDays(date, -62), date).at(-1);
  if (!last) return null;
  const from = addDays(last, 1);
  const to = paydays(member, from, addDays(from, 62))[0];
  return to ? { from, to } : null;
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
  /** Most they can deposit: one paycheck, or a week's earnings without a usable payday. */
  limitCents: number | null;
  /** Their share that did not fit in the paycheck. */
  shortCents: number;
  /** Pay as due, already in `cents`: above 0 is "In the account", below 0 is "Account short". */
  creditCents: number;
  /** Pay as due: the frozen spare money behind that credit. Below 0 is how much the account is short. */
  spareCents: number;
  /** Pay as due: the balance they typed for this deposit, or null if they haven't. */
  balanceCents: number | null;
}

type Period = { pay: ISODate; from: ISODate; to: ISODate };

/** The deposit period a date falls in; periods never overlap. Without a usable payday: the week, with Sunday as its payday. */
function periodOf(member: Member, date: ISODate): Period {
  const win = payWindow(member, addDays(date, -1));
  if (win) return { pay: addDays(win.from, -1), ...win };
  const sunday = weekStart(date);
  return { pay: sunday, from: sunday, to: addDays(sunday, 6) };
}

/** The period this week's deposit is for, or null in a week between paydays. */
function currentPeriod(member: Member, date: ISODate): Period | null {
  const start = weekStart(date);
  const pay = paydays(member, start, addDays(start, 6))[0];
  if (pay) return periodOf(member, addDays(pay, 1));
  // Every schedule pays within 62 days; no payday means a bad saved date, so keep asking weekly.
  return paydays(member, addDays(start, 7), addDays(start, 68)).length ? null : periodOf(member, date);
}

const shareOf = (member: Member, shares: Share[], cents: number) => {
  const i = shares.findIndex((s) => s.member.user_id === member.user_id);
  return i < 0 ? 0 : splitByRatio(cents, shares.map((s) => s.ratio))[i];
};

/** Shared bills still to be paid. An autopay bill whose date has passed counts as paid; it never gets a payment row. */
const openCents = (bills: Bill[], paid: Payment[], from: ISODate, to: ISODate, now: ISODate) =>
  occurrences(bills, paid, from, to)
    .filter((o) => o.bill.owner_id === null && !o.payment && !(o.bill.autopay && o.date <= now))
    .reduce((s, o) => s + o.bill.amount_cents, 0);

/**
 * Walks a partner's periods oldest first. Each deposit funds what its period asked for plus anything
 * earlier left unfunded, never more than was actually deposited.
 * held: their money still sitting in the account for open bills. owed: their share nothing has funded.
 */
function funding(member: Member, now: ISODate, through: ISODate, bills: Bill[], paid: Payment[], shares: Share[], contributions: Contribution[]) {
  let open = 0;
  let held = 0;
  for (let d = addDays(now, -60); d <= through;) {
    const p = periodOf(member, d);
    open += openCents(bills, paid, d, p.to, now);
    // What already left the account for this period came out of this deposit first.
    const spent = occurrences(bills, paid, d, p.to)
      .filter((o) => o.bill.owner_id === null && (o.payment ? o.payment.paid_by === null : o.bill.autopay && o.date <= now))
      .reduce((s, o) => s + (o.payment?.amount_cents ?? o.bill.amount_cents), 0);
    // shortcut: exact week match, so a schedule change orphans older deposits and spare reads high for up to a period; use a date range if that hurts.
    const put = contributions
      .filter((c) => c.member_id === member.user_id && c.week_start === weekStart(p.pay))
      .reduce((s, c) => s + c.amount_cents, 0);
    held += Math.max(0, Math.min(put - shareOf(member, shares, spent), shareOf(member, shares, open) - held));
    d = addDays(p.to, 1);
  }
  // shortcut: per-chunk rounding can leave 1¢ owed on a bill unpaid past the next payday; sum exact shares if anyone notices.
  return { heldCents: held, owedCents: shareOf(member, shares, open) - held };
}

/** Pay as due: what `period` asks for. Payments after payday are ignored, so paying a bill doesn't shrink the deposit. */
function payAsDue(member: Member, period: Period, bills: Bill[], payments: Payment[], shares: Share[], contributions: Contribution[], balances: AccountBalance[]) {
  const { pay, from, to } = period;
  const paid = payments.filter((p) => p.paid_on <= pay);
  const before = addDays(from, -1);
  const overdueCents = funding(member, before, before, bills, paid, shares, contributions).owedCents;
  const weekCents: number[] = [];
  for (let d = from; d <= to; d = addDays(d, 7)) {
    weekCents.push(shareOf(member, shares, openCents(bills, paid, d, addDays(d, 6) < to ? addDays(d, 6) : to, before)));
  }
  const asked = overdueCents + weekCents.reduce((s, c) => s + c, 0);
  const entry = balances.find((b) => b.member_id === member.user_id && b.week_start === weekStart(pay));
  const spare = entry?.spare_cents ?? 0;
  const creditCents = spare < 0 ? -shareOf(member, shares, -spare) : Math.min(shareOf(member, shares, spare), asked);
  return {
    cents: asked - creditCents, weeks: weekCents.length, from, to, overdueCents, weekCents,
    nextPayday: null, lastPayday: null, creditCents, spareCents: spare, balanceCents: entry?.amount_cents ?? null,
  };
}

/** The week whose balance is in use on `date`: this payday week, else their last payday's. No payday saved: this week. */
export function balanceWeek(member: Member, date: ISODate): ISODate {
  const start = weekStart(date);
  return weekStart(paydays(member, start, addDays(start, 6))[0] ?? paydays(member, addDays(start, -62), start).at(-1) ?? start);
}

/**
 * What to save when `member` types a balance for `week`. Spare is frozen here, so paying bills later can't move
 * a credit. Only a new number on the balance in use re-freezes it; an older one just corrects the record.
 */
export function balanceEntry(
  member: Member, cents: number, date: ISODate, bills: Bill[], payments: Payment[], shares: Share[], contributions: Contribution[],
  balances: AccountBalance[], week = balanceWeek(member, date),
) {
  const old = balances.find((b) => b.member_id === member.user_id && b.week_start === week);
  if (old && (week !== balanceWeek(member, date) || cents === old.amount_cents)) {
    return { week_start: week, amount_cents: cents, spare_cents: old.spare_cents };
  }
  // 62 days ahead reaches the end of any period a deposit has been made for.
  const held = shares.reduce((sum, s) => sum + funding(s.member, date, addDays(date, 62), bills, payments, shares, contributions).heldCents, 0);
  return { week_start: week, amount_cents: cents, spare_cents: cents - held };
}

/**
 * What a partner should deposit in the week containing `date`.
 * Without a saved payday it's this week's share. With one, nothing is asked in weeks
 * without a payday. A payday week covers it and every week until the next payday week (smoothed),
 * or, paying as due, the bills due from the day after payday through the next payday, in 7-day
 * chunks (that day's pay may land after its bills), plus anything still unpaid by payday as overdue.
 * Capped at one paycheck, with the remaining share reported as shortCents.
 */
export function depositDue(
  member: Member,
  date: ISODate,
  mode: WeeklyMode,
  bills: Bill[],
  payments: Payment[],
  shares: Share[],
  contributions: Contribution[],
  balances: AccountBalance[] = [],
): DepositDue {
  // Overdue bills belong to the first week only, or a multi-week deposit would count them again.
  const share = (d: ISODate, overdue = true) =>
    weekPlan(d, mode, bills, payments, shares, overdue).perMember.find((p) => p.member.user_id === member.user_id)?.sharedCents ?? 0;
  const start = weekStart(date);
  const end = addDays(start, 6);
  const monthly = shares.find((s) => s.member.user_id === member.user_id)?.income.monthlyCents ?? 0;
  const capped = (plan: Omit<DepositDue, 'limitCents' | 'shortCents'>, perYear: number): DepositDue => {
    const limitCents = monthly > 0 ? Math.round((monthly * 12) / perYear) : null;
    const cents = limitCents === null ? plan.cents : Math.min(plan.cents, limitCents);
    return { ...plan, cents, limitCents, shortCents: plan.cents - cents };
  };
  if (mode === 'due') {
    const period = currentPeriod(member, date);
    if (period) return capped(payAsDue(member, period, bills, payments, shares, contributions, balances), paydays(member, start, end).length ? PER_YEAR[member.pay_frequency] : 52);
  }
  const noBalance = { creditCents: 0, spareCents: 0, balanceCents: null };
  const cents = share(start);
  const weekly = { cents, weeks: 1, from: start, to: end, overdueCents: 0, weekCents: [cents], nextPayday: null, lastPayday: null, ...noBalance };
  if (!member.payday) return capped(weekly, 52);
  const pay = paydays(member, start, end)[0];
  if (!pay) {
    const next = paydays(member, addDays(end, 1), addDays(end, 62))[0];
    // Did they deposit on their last payday? That deposit covers this week.
    const last = paydays(member, addDays(start, -62), addDays(start, -1)).at(-1) ?? null;
    const depositedLast = !!last && contributions.some((c) => c.member_id === member.user_id && c.week_start === weekStart(last));
    // Every schedule pays within 62 days; no payday means a bad saved date, so keep asking weekly.
    return next ? capped({ cents: 0, weeks: 0, from: start, to: end, overdueCents: 0, weekCents: [], nextPayday: next, lastPayday: depositedLast ? last : null, ...noBalance }, PER_YEAR[member.pay_frequency]) : capped(weekly, 52);
  }
  // Overdue bills are asked for once, now.
  const overdueCents = cents - share(start, false);
  // Smoothed: this week up to the next payday week (at most 6 weeks; monthly pay is the longest gap).
  let weeks = 1;
  while (weeks < 6 && !paydays(member, addDays(start, 7 * weeks), addDays(start, 7 * weeks + 6)).length) weeks++;
  const weekCents = Array.from({ length: weeks }, (_, w) => share(addDays(start, 7 * w), false));
  const from = start;
  const to = addDays(start, 7 * weeks - 1);
  return capped({
    cents: overdueCents + weekCents.reduce((s, c) => s + c, 0),
    weeks: weekCents.length, from, to, overdueCents, weekCents, nextPayday: null, lastPayday: null, ...noBalance,
  }, PER_YEAR[member.pay_frequency]);
}

export interface Leftover {
  member: Member;
  incomeCents: number;
  sharedCents: number; // their split of shared bills due in the period, or their deposit (see weekLeftover)
  personalCents: number; // their own bills due in the period
  leftCents: number; // can be negative
}

const cost = (o: Occurrence) => o.payment?.amount_cents ?? o.bill.amount_cents;

/**
 * What each partner has left from a period's income after the bills actually due in it
 * (paid or not; a paid bill counts at the amount actually paid).
 * Month income for someone who logs paychecks is the checks dated in that month (including
 * ones logged ahead of time), so a mid-month start counts only what was actually paid.
 * Everyone else, and a month with nothing logged yet, uses the average month.
 * With `overdue`, unpaid bills from before the period count too (same rule as needsConfirming).
 */
export function leftover(
  bills: Bill[],
  payments: Payment[],
  shares: Share[],
  from: ISODate,
  to: ISODate,
  period: 'week' | 'month',
  paychecks: Paycheck[] = [],
  overdue = false,
): Leftover[] {
  const due = [...occurrences(bills, payments, from, to), ...(overdue ? needsConfirming(bills, payments, addDays(from, -1)) : [])];
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

/**
 * What each partner has left of this week's pay.
 * Pay as due: their pay minus their deposit, minus their personal bills due in the days that
 * deposit covers and any still unpaid from before them. Pay is the check logged in a payday week
 * or else an average paycheck, or an average week without a saved payday. A week without a payday
 * shows $0: no pay, no deposit, and the payday before it already counted its personal bills.
 * Smoothed: see leftover.
 */
export function weekLeftover(
  date: ISODate,
  mode: WeeklyMode,
  bills: Bill[],
  payments: Payment[],
  shares: Share[],
  contributions: Contribution[],
  paychecks: Paycheck[] = [],
  balances: AccountBalance[] = [],
): Leftover[] {
  const start = weekStart(date);
  const end = addDays(start, 6);
  if (mode === 'smoothed') return leftover(bills, payments, shares, start, end, 'week');
  return shares.map(({ member, income }) => {
    const due = depositDue(member, date, mode, bills, payments, shares, contributions, balances);
    const deposited = contributions
      .filter((c) => c.member_id === member.user_id && c.week_start === start)
      .reduce((sum, c) => sum + c.amount_cents, 0);
    // A bill paid by payday lowers what's asked, but a deposit already made has left the paycheck.
    const sharedCents = Math.max(due.cents, deposited);
    const logged = paychecks.filter((p) => p.member_id === member.user_id && p.paid_on >= start && p.paid_on <= end);
    const incomeCents = due.weeks === 0 ? 0
      : !paydays(member, start, end).length ? Math.round((income.monthlyCents * 12) / 52)
      : member.income_mode !== 'fixed' && logged.length ? logged.reduce((sum, p) => sum + p.amount_cents, 0)
      : Math.round((income.monthlyCents * 12) / PER_YEAR[member.pay_frequency]);
    const personalCents = due.weeks === 0 ? 0 : [...occurrences(bills, payments, due.from, due.to), ...needsConfirming(bills, payments, addDays(due.from, -1))]
      .filter((o) => o.bill.owner_id === member.user_id)
      .reduce((sum, o) => sum + cost(o), 0);
    return { member, incomeCents, sharedCents, personalCents, leftCents: incomeCents - sharedCents - personalCents };
  });
}
