import { isDemo } from './demo';
import {
  buildReportSummary, type PaymentCursor, type PaymentPage, type ReportPayment, type ReportPaymentFilter,
  type ReportRange, type ReportRanges, type ReportSummary, type SummaryData,
} from './logic/reports';
import { check, type State } from './store';
import { supabase } from './supabase';
import type { Bill, ISODate, Payment } from './types';

const PAGE_SIZE = 50;

function within(date: ISODate, range: ReportRange): boolean {
  return date >= range.from && date <= range.to;
}

function sumBy<T>(rows: T[], key: (row: T) => string, cents: (row: T) => number): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const id = key(row);
    totals.set(id, (totals.get(id) ?? 0) + cents(row));
  }
  return totals;
}

function demoSummary(state: State, ranges: ReportRanges): SummaryData {
  const bills = new Map(state.bills.map((bill) => [bill.id, bill]));
  const entries = state.payments.flatMap((payment) => {
    const bill = bills.get(payment.bill_id);
    return bill ? [{ payment, bill }] : [];
  });
  const current = entries.filter(({ payment }) => within(payment.paid_on, ranges.current));
  const monthly = entries.filter(({ payment }) => within(payment.paid_on, ranges.leftover));
  const cents = ({ payment }: { payment: Payment }) => payment.amount_cents;
  const byBill = new Map<string, SummaryData['billTotals'][number]>();
  for (const { payment, bill } of current) {
    const row = byBill.get(bill.id) ?? { id: bill.id, name: bill.name, category: bill.category, cents: 0, count: 0 };
    row.cents += payment.amount_cents;
    row.count++;
    byBill.set(bill.id, row);
  }

  function direct(rows: typeof entries) {
    const paidDirect = rows.flatMap(({ payment, bill }) =>
      bill.owner_id === null && payment.paid_by ? [{ memberId: payment.paid_by, cents: payment.amount_cents }] : []);
    return [...sumBy(paidDirect, (r) => r.memberId, (r) => r.cents)]
      .map(([memberId, cents]) => ({ memberId, cents }));
  }

  function deposits(range: ReportRange) {
    return [...sumBy(state.contributions.filter((p) => within(p.week_start, range)),
      (p) => p.member_id, (p) => p.amount_cents)]
      .map(([member_id, amount_cents]) => ({ member_id, amount_cents }));
  }

  const monthlyContributions: SummaryData['monthlyContributions'] = [];
  if (ranges.period === 'year') {
    const byMonth = new Map<ISODate, Map<string, number>>();
    function addContribution(date: ISODate, memberId: string, cents: number) {
      const month = date.slice(0, 7) + '-01';
      const totals = byMonth.get(month) ?? new Map<string, number>();
      totals.set(memberId, (totals.get(memberId) ?? 0) + cents);
      byMonth.set(month, totals);
    }
    for (const { payment, bill } of current) {
      if (bill.owner_id === null && payment.paid_by) {
        addContribution(payment.paid_on, payment.paid_by, payment.amount_cents);
      }
    }
    for (const deposit of state.contributions) {
      if (within(deposit.week_start, ranges.current)) {
        addContribution(deposit.week_start, deposit.member_id, deposit.amount_cents);
      }
    }
    for (const [month, totals] of byMonth) {
      for (const [memberId, cents] of totals) monthlyContributions.push({ month, memberId, cents });
    }
  }

  const anchorByMember = new Map<string, ISODate>();
  for (const pay of state.paychecks) {
    if (pay.paid_on <= ranges.leftover.to && pay.paid_on > (anchorByMember.get(pay.member_id) ?? '')) {
      anchorByMember.set(pay.member_id, pay.paid_on);
    }
  }

  return {
    billTotals: [...byBill.values()].sort((a, b) => a.name.localeCompare(b.name)),
    previousPaidCents: entries.filter(({ payment }) => within(payment.paid_on, ranges.previous))
      .reduce((total, row) => total + cents(row), 0),
    paidOccurrences: state.payments.filter((p) => within(p.due_date, ranges.current) && p.paid_on <= ranges.today),
    bills: state.bills,
    months: [...sumBy(current, ({ payment }) => payment.paid_on.slice(0, 7) + '-01', cents)]
      .map(([month, cents]) => ({ month, cents })),
    monthlyContributions,
    periodDirect: direct(current),
    monthDirect: direct(monthly),
    monthPersonal: [...sumBy(monthly.flatMap(({ bill, payment }) =>
      bill.owner_id !== null && payment.paid_by ? [{ memberId: payment.paid_by, cents: payment.amount_cents }] : []),
    (r) => r.memberId, (r) => r.cents)].map(([memberId, cents]) => ({ memberId, cents })),
    periodDeposits: deposits(ranges.current),
    monthDeposits: deposits(ranges.leftover),
    checks: state.paychecks.filter((p) => within(p.paid_on, ranges.leftover)),
    paycheckAnchors: [...anchorByMember].map(([memberId, date]) => ({ memberId, date })),
  };
}

export async function getReportSummary(state: State, ranges: ReportRanges): Promise<ReportSummary> {
  const data = isDemo ? demoSummary(state, ranges) : check<SummaryData | null>(await supabase.rpc('report_summary', {
    p_household: state.household.id,
    p_from: ranges.current.from,
    p_to: ranges.current.to,
    p_previous_from: ranges.previous.from,
    p_previous_to: ranges.previous.to,
    p_month_from: ranges.leftover.from,
    p_month_to: ranges.leftover.to,
    p_as_of: ranges.today,
  }));
  if (!data) throw new Error('Reports are unavailable for this household or date range.');
  return buildReportSummary(data, state.members, ranges);
}

function reportPayment(payment: Payment, bill: Bill): ReportPayment {
  return {
    id: payment.id, billId: bill.id, billName: bill.name, category: bill.category,
    paidOn: payment.paid_on, paidBy: payment.paid_by, cents: payment.amount_cents,
  };
}

export async function getReportPayments(
  state: State, range: ReportRange, filter: ReportPaymentFilter, cursor?: PaymentCursor,
): Promise<PaymentPage> {
  let page: ReportPayment[];
  if (isDemo) {
    const bills = new Map(state.bills.map((bill) => [bill.id, bill]));
    page = state.payments.flatMap((p) => {
      const bill = bills.get(p.bill_id);
      if (!bill || !within(p.paid_on, range) || (filter.billId && bill.id !== filter.billId) ||
          (filter.category && bill.category.toLowerCase() !== filter.category.toLowerCase()) ||
          (cursor && !(p.paid_on < cursor.paidOn || (p.paid_on === cursor.paidOn && p.id < cursor.id)))) return [];
      return [reportPayment(p, bill)];
    }).sort((a, b) => b.paidOn.localeCompare(a.paidOn) || (a.id < b.id ? 1 : -1));
  } else {
    page = check<ReportPayment[]>(await supabase.rpc('report_payments', {
      p_household: state.household.id,
      p_from: range.from,
      p_to: range.to,
      p_category: filter.category ?? null,
      p_bill: filter.billId ?? null,
      p_cursor_date: cursor?.paidOn ?? null,
      p_cursor_id: cursor?.id ?? null,
    }));
  }
  const rows = page.slice(0, PAGE_SIZE);
  const last = rows.at(-1);
  return {
    rows,
    nextCursor: page.length > PAGE_SIZE && last ? { paidOn: last.paidOn, id: last.id } : undefined,
  };
}
