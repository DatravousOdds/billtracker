import { addDays, weekStart } from '../../../src/logic/dates.ts';
import { paydays } from '../../../src/logic/income.ts';
import { applyDepositCredit, depositDue, incomeShares } from '../../../src/logic/split.ts';
import type { Bill, Contribution, Household, Member, Payment, Paycheck } from '../../../src/types.ts';

interface Sources {
  households: Household;
  members: Member;
  bills: Bill;
  payments: Payment;
  contributions: Contribution;
  paychecks: Paycheck;
}

type Source = keyof Sources;
type Rows = { [K in Source]: Sources[K][] | null };
type Change = { [K in Source]: {
  source: K;
  row_id: string;
  changed_at: string;
  before_row: Sources[K] | null;
} }[Source];

export interface Settlement {
  member_id: string;
  member_created_at: string;
  period_start: string;
  next_period_start: string;
  carry_cents: number;
}

interface Claim {
  bill_id: string;
  due_date: string;
}

export interface SettlementInputs extends Rows {
  householdId: string;
  asOf: string;
  rollout: string;
  revision: string;
  watermark: string | null;
  claims: Claim[] | null;
  changes: Change[] | null;
  settlements: Settlement[] | null;
}

const sources = ['households', 'members', 'bills', 'payments', 'contributions', 'paychecks'] as const;

function snapshot(inputs: SettlementInputs, before: string) {
  const date = Date.parse(before);
  const tables = Object.fromEntries(sources.map((source) => [source, new Map(
    (inputs[source] ?? []).map((row) => ['user_id' in row ? row.user_id : row.id, row]),
  )]));
  for (const change of inputs.changes ?? []) {
    if (Date.parse(change.changed_at) < date) continue;
    const table = tables[change.source];
    if (change.before_row) table.set(change.row_id, change.before_row);
    else table.delete(change.row_id);
  }
  return Object.fromEntries(sources.map((source) => [source, [...tables[source].values()]])) as {
    [K in Source]: Sources[K][]
  };
}

function nextPeriod(member: Member, date: string): string {
  return paydays(member, addDays(date, 1), addDays(date, 62))[0] ?? addDays(weekStart(date), 7);
}

export function calculateSettlements(inputs: SettlementInputs) {
  const today = new Date(inputs.asOf).toISOString().slice(0, 10);
  const rollout = new Date(inputs.rollout).toISOString().slice(0, 10);
  const at = new Map<string, ReturnType<typeof snapshot>>();
  const midnight = (date: string) => {
    const saved = at.get(date);
    if (saved) return saved;
    const state = snapshot(inputs, date + 'T00:00:00Z');
    at.set(date, state);
    return state;
  };
  const closed: Settlement[] = [];
  const members: Record<string, ReturnType<typeof applyDepositCredit> & {
    baseCents: number; periodStart: string; nextPeriodStart: string;
  }> = {};

  const periods: { member: Member; from: string; next: string }[] = [];
  const carryByMember = new Map<string, number>();
  const tenure = (member: Member) => member.user_id + '|' + member.created_at;
  const active = new Set((inputs.members ?? []).map(tenure));
  const known = new Map((inputs.members ?? []).map((member) => [tenure(member), member]));
  for (const change of inputs.changes ?? []) {
    if (change.source === 'members' && change.before_row) {
      known.set(tenure(change.before_row), change.before_row);
    }
  }
  for (const [key, member] of known) {
    const joined = new Date(member.created_at).toISOString().slice(0, 10);
    const startAfter = joined > rollout ? joined : rollout;
    const latest = (inputs.settlements ?? [])
      .filter((s) => s.member_id === member.user_id
        && Date.parse(s.member_created_at) === Date.parse(member.created_at))
      .sort((a, b) => b.period_start.localeCompare(a.period_start))[0];
    if (latest) carryByMember.set(key, latest.carry_cents);
    let from = latest?.next_period_start ?? addDays(startAfter, 1);
    if (inputs.watermark && from < inputs.watermark) from = inputs.watermark;
    let first = !latest;
    while (from <= today) {
      const scheduled = midnight(from).members.find((m) => tenure(m) === key);
      if (!scheduled) {
        from = addDays(from, 1);
        continue;
      }
      if (first) {
        const boundary = nextPeriod(scheduled, addDays(from, -1));
        if (boundary > from) {
          from = boundary;
          continue;
        }
        first = false;
      }
      const next = nextPeriod(scheduled, from);
      periods.push({ member: scheduled, from, next });
      from = next;
    }
  }

  // Close every member's periods in date order so a corrected occurrence cannot earn credit twice.
  periods.sort((a, b) => a.next.localeCompare(b.next));
  const claimKey = (claim: Claim) => claim.bill_id + '|' + claim.due_date;
  const claimed = new Set((inputs.claims ?? []).map(claimKey));
  const newClaims: Claim[] = [];
  let watermark = today;
  for (const { member: scheduled, from, next } of periods) {
    const isClosed = next <= today;
    const through = isClosed ? addDays(next, -1) : today;
    const state = isClosed ? midnight(next) : inputs;
    const key = tenure(scheduled);
    const household = state.households?.[0];
    if (!household || !state.members?.some((member) => tenure(member) === key)) continue;
    if (!isClosed && from < watermark) watermark = from;
    const billList = state.bills ?? [];
    const paymentList = state.payments ?? [];
    const shareList = incomeShares(state.members ?? [], state.paychecks ?? [], through, household);
    const target = depositDue(scheduled, from, household.weekly_mode, billList, paymentList, shareList,
      state.contributions ?? [], { from, through });
    const deposits = (state.contributions ?? [])
      .filter((c) => c.member_id === scheduled.user_id && c.week_start === weekStart(from))
      .reduce((sum, c) => sum + c.amount_cents, 0);
    const shared = new Set(billList.filter((b) => b.owner_id === null).map((b) => b.id));
    let paid = 0;
    for (const payment of paymentList) {
      const occurrence = claimKey(payment);
      if (payment.paid_by !== scheduled.user_id || payment.paid_on < from || payment.paid_on > through
        || !shared.has(payment.bill_id) || claimed.has(occurrence)) continue;
      claimed.add(occurrence);
      if (isClosed) newClaims.push({ bill_id: payment.bill_id, due_date: payment.due_date });
      paid += payment.amount_cents;
    }
    const prior = carryByMember.get(key) ?? 0;
    const credit = applyDepositCredit(target.cents, deposits, paid, prior);
    if (!isClosed) {
      members[scheduled.user_id] = { ...credit, baseCents: target.cents, periodStart: from, nextPeriodStart: next };
      continue;
    }
    carryByMember.set(key, credit.carryCents);
    if (active.has(key)) closed.push({
      member_id: scheduled.user_id, member_created_at: scheduled.created_at,
      period_start: from, next_period_start: next, carry_cents: credit.carryCents,
    });
  }
  return { closed, members, claims: newClaims, watermark };
}
