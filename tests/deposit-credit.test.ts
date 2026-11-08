import { describe, expect, it } from 'vitest';
import { calculateSettlements, type SettlementInputs } from '../supabase/functions/deposit-credit/settlement';
import type { Bill, Member } from '../src/types';

const member = (user_id: string): Member => ({
  user_id, household_id: 'home', display_name: user_id, pay_amount_cents: 100000,
  pay_frequency: 'weekly', income_mode: 'fixed', paycheck_average: 'auto',
  payday: null, created_at: '2026-09-01T00:00:00Z',
});
const bill = (id: string, amount_cents: number, start_date: string): Bill => ({
  id, household_id: 'home', name: id, amount_cents, start_date, owner_id: null,
  category: 'Other', active: true, autopay: false, recurrence: 'once', created_at: '2026-09-01T00:00:00Z',
});

describe('deposit credit settlement', () => {
  it.each(['due', 'smoothed'] as const)('recovers the close-time balance offline in %s mode', (weekly_mode) => {
    const a = member('a');
    const b = member('b');
    const shared = bill('repair', 13000, '2026-10-04');
    const inputs: SettlementInputs = {
      householdId: 'home', asOf: '2026-10-12T12:00:00Z', rollout: '2026-10-01T10:00:00Z',
      revision: '1', watermark: null, claims: [],
      households: [{
        id: 'home', name: 'Home', invite_code: '', weekly_mode, split_member: null, split_percent: null,
        split_proposed_by: null, split_proposed_percent: null,
      }],
      members: [{ ...a, pay_amount_cents: 200000 }, b],
      bills: [shared, bill('water', 7000, '2026-10-05'), bill('phone', 15000, '2026-10-12')],
      contributions: [], paychecks: [], settlements: [],
      payments: [{
        id: 'p', household_id: 'home', bill_id: 'repair', paid_by: 'a',
        paid_on: '2026-10-04', due_date: '2026-10-04', amount_cents: 13000,
      }],
      changes: [{
        // A transaction can append again after a concurrent transaction starts.
        source: 'bills', row_id: shared.id, before_row: null, changed_at: '2026-10-03T00:00:00Z',
      }, {
        source: 'members', row_id: 'a', before_row: a, changed_at: '2026-10-11T01:00:00Z',
      }],
    };
    const result = calculateSettlements(inputs);
    expect(result.closed).toContainEqual({
      member_id: 'a', member_created_at: a.created_at, period_start: '2026-10-04', next_period_start: '2026-10-11', carry_cents: 3000,
    });
    expect(result.members.a).toMatchObject({ priorCreditCents: 3000, paidDirectCents: 0, remainingCents: weekly_mode === 'due' ? 11667 : 7000 });
    expect(result.members.b).toMatchObject({ priorCreditCents: 0, remainingCents: weekly_mode === 'due' ? 7333 : 5000 });
    const checkpointed = {
      ...inputs, settlements: result.closed, claims: result.claims, watermark: result.watermark,
    };
    expect(calculateSettlements(checkpointed).closed).toEqual([]);
    expect(result.watermark).toBe('2026-10-11');
    expect(result.claims).toEqual([{ bill_id: 'repair', due_date: '2026-10-04' }]);

    const corrected = {
      ...inputs.payments![0], paid_by: 'b', paid_on: '2026-10-12',
    };
    const afterCorrection = calculateSettlements({
      ...checkpointed,
      payments: [corrected],
      changes: [{
        source: 'payments', row_id: corrected.id, changed_at: '2026-10-12T10:00:00Z',
        before_row: inputs.payments![0],
      }, ...inputs.changes!],
    });
    expect(afterCorrection.members.a.priorCreditCents).toBe(3000);
    expect(afterCorrection.members.b.paidDirectCents).toBe(0);

    const afterDeparture = calculateSettlements({
      ...checkpointed,
      members: [b],
      settlements: result.closed.filter((settlement) => settlement.member_id === 'b'),
      payments: [corrected],
      changes: [],
    });
    expect(afterDeparture.members.b.paidDirectCents).toBe(0);
    expect(afterDeparture.claims).toEqual([]);

    const firstVisitAfterDeparture = calculateSettlements({
      ...inputs,
      members: [b],
      payments: [corrected],
      changes: [{
        source: 'payments', row_id: corrected.id, changed_at: '2026-10-12T10:00:00Z',
        before_row: inputs.payments![0],
      }, {
        source: 'members', row_id: 'a', changed_at: '2026-10-12T09:00:00Z',
        before_row: inputs.members![0],
      }, ...inputs.changes!],
    });
    expect(firstVisitAfterDeparture.claims).toEqual(result.claims);
    expect(firstVisitAfterDeparture.members.b.paidDirectCents).toBe(0);
  });
});
