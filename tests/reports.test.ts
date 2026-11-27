import { describe, expect, it } from 'vitest';
import { buildReportSummary, reportRanges, type SummaryData } from '../src/logic/reports';
import type { Member } from '../src/types';

const alex: Member = {
  user_id: 'alex', display_name: 'Alex', household_id: 'home', created_at: '',
  pay_amount_cents: 10000, pay_frequency: 'biweekly', payday: '2026-11-06',
  income_mode: 'per_paycheck', paycheck_average: 'auto',
};

const data: SummaryData = {
  billTotals: [
    { id: 'power', name: 'Power', category: 'Utilities', cents: 3000, count: 1 },
    { id: 'water', name: 'Water', category: 'utilities', cents: 2000, count: 1 },
  ],
  previousPaidCents: 2500,
  paidOccurrences: [{ bill_id: 'power', due_date: '2026-11-02' }],
  bills: [
    { id: 'power', recurrence: 'monthly', start_date: '2026-01-02', amount_cents: 3000, active: true, autopay: false },
    { id: 'water', recurrence: 'monthly', start_date: '2026-01-02', amount_cents: 2000, active: true, autopay: true },
    { id: 'other', recurrence: 'once', start_date: '2026-11-05', amount_cents: 2500, active: true, autopay: false },
  ],
  monthlyContributions: [],
  months: [{ month: '2026-11-01', cents: 5000 }],
  periodDirect: [{ memberId: 'alex', cents: 3000 }],
  monthDirect: [{ memberId: 'alex', cents: 3000 }],
  monthPersonal: [{ memberId: 'alex', cents: 4000 }],
  periodDeposits: [{ member_id: 'alex', amount_cents: 5000 }],
  monthDeposits: [{ member_id: 'alex', amount_cents: 5000 }],
  checks: [{ member_id: 'alex', paid_on: '2026-11-06', amount_cents: 9000 }],
  paycheckAnchors: [],
};

describe('reports', () => {
  it('compares elapsed days, includes the leap day, and uses Sunday weeks', () => {
    expect(reportRanges('month', '2024-03-01', '2024-03-30')).toMatchObject({
      current: { from: '2024-03-01', to: '2024-03-30' },
      previous: { from: '2024-02-01', to: '2024-02-29' },
    });
    expect(reportRanges('week', '2026-12-01', '2026-12-08')).toMatchObject({
      current: { from: '2026-11-29', to: '2026-12-05' },
      leftover: { from: '2026-12-01', to: '2026-12-08' },
    });
  });

  it('reconciles spending and category totals and separates deposits from spending', () => {
    const summary = buildReportSummary(data, [alex], reportRanges('month', '2026-11-27', '2026-11-27'));
    expect(summary).toMatchObject({
      paidCents: 5000, previousPaidCents: 2500, unpaidCents: 2500,
      categories: [{ category: 'Utilities', cents: 5000, count: 2 }],
      members: [{ depositedCents: 5000, directCents: 3000, personalCents: 4000,
        incomeCents: 19000, estimatedIncome: true, leftCents: 7000 }],
    });
  });

  it('fills only elapsed months, and can show a negative leftover using logged checks only', () => {
    const summary = buildReportSummary(data, [{ ...alex, pay_amount_cents: 0 }],
      reportRanges('year', '2026-01-01', '2026-11-27'));
    expect(summary.months).toHaveLength(11);
    expect(summary.months[10]).toEqual({ month: '2026-11-01', cents: 5000 });
    expect(summary.members[0]).toMatchObject({ incomeCents: 9000, leftCents: -3000, estimatedIncome: false });
  });

  it('projects a historical schedule from a saved date several years later', () => {
    const summary = buildReportSummary({ ...data, checks: [] }, [alex], reportRanges('month', '2022-11-01', '2026-11-27'));
    expect(summary.members[0]).toMatchObject({ incomeCents: 20000, estimatedIncome: true });
  });

  it('preserves month-end schedule anchors when estimating across years', () => {
    const member = { ...alex, pay_frequency: 'monthly', payday: '2024-02-29' } as const;
    const report = (today: string) => buildReportSummary({ ...data, checks: [] }, [member],
      reportRanges('month', today, today)).members[0];
    expect(report('2020-02-28').incomeCents).toBe(0);
    expect(report('2020-02-29').incomeCents).toBe(10000);
  });

  it('does not estimate income before the member joined', () => {
    const joinedLater = { ...alex, created_at: '2026-12-01T00:00:00.000Z' };
    const summary = buildReportSummary({ ...data, checks: [] }, [joinedLater],
      reportRanges('month', '2026-11-01', '2026-12-10'));
    expect(summary.members[0]).toMatchObject({ incomeCents: 0, estimatedIncome: false });
  });
});
