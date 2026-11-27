import type { Bill, Contribution, ISODate, Member, Payment, Paycheck } from '../types';
import { addDays, addMonths, daysBetween, toDate, weekStart } from './dates';
import { PER_YEAR } from './income';
import { dueDates } from './recurrence';

export type ReportPeriod = 'week' | 'month' | 'year';
export interface ReportRange { from: ISODate; to: ISODate }

export interface ReportRanges {
  period: ReportPeriod;
  current: ReportRange;
  previous: ReportRange;
  leftover: ReportRange;
  periodEnd: ISODate;
  today: ISODate;
}

function periodStart(period: ReportPeriod, anchor: ISODate): ISODate {
  if (period === 'week') return weekStart(anchor);
  return period === 'month' ? monthStart(anchor) : anchor.slice(0, 4) + '-01-01';
}

function monthStart(date: ISODate): ISODate {
  return date.slice(0, 7) + '-01';
}

export function shiftReportAnchor(period: ReportPeriod, anchor: ISODate, direction: number): ISODate {
  const start = periodStart(period, anchor);
  return period === 'week' ? addDays(start, direction * 7) : addMonths(start, direction * (period === 'year' ? 12 : 1));
}

export function reportRanges(period: ReportPeriod, anchor: ISODate, today: ISODate): ReportRanges {
  const from = periodStart(period, anchor);
  const periodEnd = addDays(shiftReportAnchor(period, from, 1), -1);
  const to = minDate(periodEnd, today);
  const previousFrom = shiftReportAnchor(period, from, -1);
  const previousEnd = addDays(from, -1);
  const previousTo = to === periodEnd
    ? previousEnd
    : minDate(previousEnd, addDays(previousFrom, daysBetween(from, to)));
  const leftoverFrom = monthStart(to);

  return {
    period,
    current: { from, to },
    previous: { from: previousFrom, to: previousTo },
    leftover: { from: leftoverFrom, to: minDate(today, addDays(addMonths(leftoverFrom, 1), -1)) },
    periodEnd,
    today,
  };
}

function minDate(a: ISODate, b: ISODate): ISODate {
  return a < b ? a : b;
}

interface BillTotal { id: string; name: string; cents: number; count: number }
export interface ReportCategory {
  category: string;
  cents: number;
  count: number;
  bills: BillTotal[];
}

export interface ReportMember {
  id: string;
  name: string;
  depositedCents: number;
  directCents: number;
  personalCents: number;
  monthlyDepositedCents: number;
  monthlyDirectCents: number;
  incomeCents: number;
  estimatedIncome: boolean;
  leftCents: number;
}

export interface ReportSummary {
  paidCents: number;
  previousPaidCents: number;
  unpaidCents: number;
  categories: ReportCategory[];
  members: ReportMember[];
  months: { month: ISODate; cents: number }[];
  monthlyContributions: { month: ISODate; memberId: string; cents: number }[];
}

export interface ReportPayment {
  id: string;
  billId: string;
  billName: string;
  category: string;
  paidOn: ISODate;
  paidBy: string | null;
  cents: number;
}
export interface ReportPaymentFilter { category?: string; billId?: string }
export interface PaymentCursor { paidOn: ISODate; id: string }
export interface PaymentPage { rows: ReportPayment[]; nextCursor?: PaymentCursor }

type Deposit = Pick<Contribution, 'member_id' | 'amount_cents'>;
type Check = Pick<Paycheck, 'member_id' | 'paid_on' | 'amount_cents'>;
type PaidOccurrence = Pick<Payment, 'bill_id' | 'due_date'>;
type ReportBill = Pick<Bill, 'id' | 'amount_cents' | 'start_date' | 'recurrence' | 'active' | 'autopay'>;

export interface SummaryData {
  billTotals: (BillTotal & { category: string })[];
  previousPaidCents: number;
  paidOccurrences: PaidOccurrence[];
  bills: ReportBill[];
  months: ReportSummary['months'];
  monthlyContributions: ReportSummary['monthlyContributions'];
  periodDirect: { memberId: string; cents: number }[];
  monthDirect: { memberId: string; cents: number }[];
  monthPersonal: { memberId: string; cents: number }[];
  periodDeposits: Deposit[];
  monthDeposits: Deposit[];
  checks: Check[];
  paycheckAnchors: { memberId: string; date: ISODate }[];
}

function monthlyIncomeForReport(member: Member, checks: Check[], anchor: ISODate | undefined, range: ReportRange) {
  const actual = checks.reduce((total, p) => total + p.amount_cents, 0);
  const joined = member.created_at.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(joined) && joined > range.to) {
    return { incomeCents: actual, estimatedIncome: false };
  }

  const payday = member.payday ?? anchor;
  let scheduled: number;
  if (payday) {
    if (member.pay_frequency === 'weekly' || member.pay_frequency === 'biweekly') {
      const cycle = member.pay_frequency === 'weekly' ? 7 : 14;
      const first = addDays(payday, Math.ceil(daysBetween(payday, range.from) / cycle) * cycle);
      scheduled = Math.floor(daysBetween(first, range.to) / cycle) + 1;
    } else {
      const targetMonth = toDate(range.from);
      const anchors = member.pay_frequency === 'semimonthly' ? [payday, addDays(payday, 15)] : [payday];
      scheduled = anchors.filter((anchor) => {
        const date = toDate(anchor);
        const offset = (targetMonth.getUTCFullYear() - date.getUTCFullYear()) * 12
          + targetMonth.getUTCMonth() - date.getUTCMonth();
        return addMonths(anchor, offset) <= range.to;
      }).length;
    }
  } else {
    const monthLength = daysBetween(range.from, addMonths(range.from, 1));
    scheduled = PER_YEAR[member.pay_frequency] / 12 * (daysBetween(range.from, range.to) + 1) / monthLength;
  }
  const estimate = Math.round(Math.max(0, scheduled - checks.length) * member.pay_amount_cents);
  return { incomeCents: actual + estimate, estimatedIncome: estimate > 0 };
}

export function buildReportSummary(data: SummaryData, members: Member[], ranges: ReportRanges): ReportSummary {
  const categories = new Map<string, ReportCategory>();
  let paidCents = 0;
  for (const { category, ...bill } of data.billTotals) {
    paidCents += bill.cents;
    const key = category.toLowerCase();
    const group = categories.get(key) ?? { category, cents: 0, count: 0, bills: [] };
    group.cents += bill.cents;
    group.count += bill.count;
    group.bills.push(bill);
    categories.set(key, group);
  }

  const paidOccurrences = new Set(data.paidOccurrences.map((p) => `${p.bill_id}/${p.due_date}`));
  let unpaidCents = 0;
  for (const bill of data.bills) {
    // Autopay records are optional in the app, so missing ones do not imply unpaid bills.
    if (!bill.active || bill.autopay) continue;
    for (const date of dueDates(bill, ranges.current.from, ranges.current.to)) {
      if (!paidOccurrences.has(`${bill.id}/${date}`)) unpaidCents += bill.amount_cents;
    }
  }

  const months = new Map(data.months.map((m) => [m.month, m.cents]));
  return {
    paidCents,
    previousPaidCents: data.previousPaidCents,
    unpaidCents,
    categories: [...categories.values()]
      .map((c) => ({ ...c, bills: c.bills.sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name)) }))
      .sort((a, b) => b.cents - a.cents || a.category.localeCompare(b.category)),
    members: members.map((member) => {
      const id = member.user_id;
      const depositedCents = data.periodDeposits.find((deposit) => deposit.member_id === id)?.amount_cents ?? 0;
      const monthlyDepositedCents = data.monthDeposits.find((deposit) => deposit.member_id === id)?.amount_cents ?? 0;
      const directCents = data.periodDirect.find((entry) => entry.memberId === id)?.cents ?? 0;
      const monthlyDirectCents = data.monthDirect.find((entry) => entry.memberId === id)?.cents ?? 0;
      const personalCents = data.monthPersonal.find((entry) => entry.memberId === id)?.cents ?? 0;
      const income = monthlyIncomeForReport(member, data.checks.filter((check) => check.member_id === id),
        data.paycheckAnchors.find((entry) => entry.memberId === id)?.date, ranges.leftover);

      return {
        id, name: member.display_name, depositedCents, directCents, personalCents, monthlyDepositedCents, monthlyDirectCents,
        ...income, leftCents: income.incomeCents - personalCents - monthlyDepositedCents - monthlyDirectCents,
      };
    }),
    monthlyContributions: data.monthlyContributions,
    months: ranges.period === 'year' ? [...Array(12)].map((_, i) => addMonths(ranges.current.from, i))
      .filter((month) => month <= ranges.current.to).map((month) => ({ month, cents: months.get(month) ?? 0 })) : [],
  };
}
