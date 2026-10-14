import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type {
  ActivityEntry, Bill, BillRequest, Contribution, Household, Member, Payment, Paycheck,
} from './types';
import { todayISO } from './logic/dates';
import { incomeShares, type Share } from './logic/split';
import { formatCents } from './logic/money';
import { demoLog, demoState, isDemo, newId } from './demo';

export interface State {
  userId: string;
  household: Household;
  members: Member[];
  bills: Bill[];
  payments: Payment[];
  contributions: Contribution[];
  paychecks: Paycheck[];
  requests: BillRequest[];
  activity: ActivityEntry[];
}

let state: State | null = null;
let channel: RealtimeChannel | null = null;
const listeners = new Set<() => void>();

export function getState(): State {
  if (!state) throw new Error('Not loaded');
  return state;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  listeners.forEach((fn) => fn());
}

function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

/** Is the signed-in user in a household yet? Returns its id or null. */
export async function findMyHousehold(userId: string): Promise<string | null> {
  const row = check(await supabase.from('members').select('household_id').eq('user_id', userId).maybeSingle());
  return row ? (row as { household_id: string }).household_id : null;
}

/** Load everything for the household. RLS already limits every query to your household. */
export async function load(userId: string, householdId: string): Promise<void> {
  const [household, members, bills, payments, contributions, paychecks, requests, activity] = await Promise.all([
    supabase.from('households').select('*').eq('id', householdId).single(),
    supabase.from('members').select('*').order('created_at'),
    supabase.from('bills').select('*').order('name'),
    supabase.from('payments').select('*'),
    supabase.from('contributions').select('*').order('week_start', { ascending: false }),
    supabase.from('paychecks').select('*').order('paid_on', { ascending: false }),
    supabase.from('bill_requests').select('*').order('created_at', { ascending: false }),
    supabase.from('activity_log').select('id, actor, message, created_at').order('created_at', { ascending: false }).limit(200),
  ]);
  state = {
    userId,
    household: check(household) as Household,
    members: check(members) as Member[],
    bills: check(bills) as Bill[],
    payments: check(payments) as Payment[],
    contributions: check(contributions) as Contribution[],
    paychecks: check(paychecks) as Paycheck[],
    requests: check(requests) as BillRequest[],
    activity: check(activity) as ActivityEntry[],
  };
  emit();
  startRealtime(userId, householdId);
}

/** Reload whenever anything in the household changes — on this phone or your partner's. */
function startRealtime(userId: string, householdId: string) {
  if (channel) return;
  let timer: number | undefined;
  const refresh = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => load(userId, householdId).catch(console.error), 250);
  };
  channel = supabase.channel(`household-${householdId}`);
  const tables = ['members', 'bills', 'payments', 'contributions', 'paychecks', 'bill_requests', 'activity_log'];
  for (const table of tables) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `household_id=eq.${householdId}` }, refresh);
  }
  channel.on('postgres_changes', { event: '*', schema: 'public', table: 'households', filter: `id=eq.${householdId}` }, refresh);
  channel.subscribe();

  // Phones pause background tabs; catch up when the app comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
}

export async function stopRealtime() {
  if (channel) await supabase.removeChannel(channel);
  channel = null;
  state = null;
}

async function reload() {
  const s = getState();
  await load(s.userId, s.household.id);
}

// ---------- Derived ----------

export function shares(): Share[] {
  const s = getState();
  return incomeShares(s.members, s.paychecks, s.household.income_window_months, todayISO());
}

export function memberName(id: string | null): string {
  if (id === null) return 'Shared account';
  return getState().members.find((m) => m.user_id === id)?.display_name ?? 'Former partner';
}

// ---------- Demo mode ----------
// In demo mode everything below changes the in-memory sample data instead of Supabase.

export function loadDemo(): void {
  state = demoState();
  emit();
}

/** Demo only: act as the other partner, to see both phones' point of view. */
export function demoSwitchUser(): void {
  const s = getState();
  const other = s.members.find((m) => m.user_id !== s.userId);
  if (other) s.userId = other.user_id;
  emit();
}

function local(change: (s: State) => void, log?: (s: State) => string) {
  const s = getState();
  change(s);
  if (log) demoLog(s, log(s));
  emit();
}

const me = (s: State) => s.members.find((m) => m.user_id === s.userId)!.display_name;

// ---------- Mutations (each reloads so this phone updates instantly) ----------

export async function createHousehold(name: string, displayName: string) {
  check(await supabase.rpc('create_household', { p_household_name: name, p_display_name: displayName }));
}

export async function joinHousehold(code: string, displayName: string) {
  check(await supabase.rpc('join_household', { p_invite_code: code, p_display_name: displayName }));
}

export type BillInput = Pick<Bill, 'name' | 'amount_cents' | 'category' | 'recurrence' | 'start_date' | 'autopay' | 'active'>;

export async function saveBill(id: string | null, input: BillInput) {
  const s = getState();
  if (isDemo) {
    if (id) {
      const old = s.bills.find((b) => b.id === id)!;
      return local(() => Object.assign(old, input), (s) =>
        `${me(s)} edited ${input.name}`);
    }
    return local((s) => s.bills.push({ ...input, id: newId(), household_id: s.household.id, owner_id: null, created_at: new Date().toISOString() }),
      (s) => `${me(s)} added ${input.name} (${formatCents(input.amount_cents)}, ${input.recurrence})`);
  }
  if (id) check(await supabase.from('bills').update(input).eq('id', id));
  else check(await supabase.from('bills').insert({ ...input, household_id: s.household.id }));
  await reload();
}

export async function deleteBill(id: string) {
  if (isDemo) {
    const name = getState().bills.find((b) => b.id === id)?.name;
    return local((s) => {
      s.bills = s.bills.filter((b) => b.id !== id);
      s.payments = s.payments.filter((p) => p.bill_id !== id);
      s.requests = s.requests.filter((r) => r.bill_id !== id);
    }, (s) => `${me(s)} deleted ${name}`);
  }
  check(await supabase.from('bills').delete().eq('id', id));
  await reload();
}

export async function markPaid(bill: Bill, dueDate: string, amountCents: number, paidBy: string | null, paidOn: string) {
  const s = getState();
  if (isDemo) {
    return local((s) => s.payments.push({
      id: newId(), household_id: s.household.id, bill_id: bill.id, due_date: dueDate,
      amount_cents: amountCents, paid_by: paidBy, paid_on: paidOn,
    }), (s) => `${me(s)} marked ${bill.name} (due ${dueDate}) paid: ${formatCents(amountCents)} by ${memberName(paidBy)}`);
  }
  check(await supabase.from('payments').insert({
    household_id: s.household.id, bill_id: bill.id, due_date: dueDate,
    amount_cents: amountCents, paid_by: paidBy, paid_on: paidOn,
  }));
  await reload();
}

export async function unmarkPaid(paymentId: string) {
  if (isDemo) {
    return local((s) => { s.payments = s.payments.filter((p) => p.id !== paymentId); },
      (s) => `${me(s)} unmarked a payment`);
  }
  check(await supabase.from('payments').delete().eq('id', paymentId));
  await reload();
}

/** Record a deposit by the signed-in partner. You can't record one for your partner. */
export async function addContribution(weekStart: string, amountCents: number) {
  const s = getState();
  const memberId = s.userId;
  if (isDemo) {
    return local((s) => s.contributions.unshift({
      id: newId(), household_id: s.household.id, member_id: memberId, week_start: weekStart, amount_cents: amountCents,
    }), () => `${memberName(memberId)} put ${formatCents(amountCents)} into the bill account (week of ${weekStart})`);
  }
  check(await supabase.from('contributions').insert({
    household_id: s.household.id, member_id: memberId, week_start: weekStart, amount_cents: amountCents,
  }));
  await reload();
}

export async function deleteContribution(id: string) {
  if (isDemo) {
    return local((s) => { s.contributions = s.contributions.filter((c) => !(c.id === id && c.member_id === s.userId)); },
      (s) => `${me(s)} removed a deposit`);
  }
  check(await supabase.from('contributions').delete().eq('id', id));
  await reload();
}

export async function updateMember(userId: string, patch: Partial<Pick<Member, 'display_name' | 'pay_amount_cents' | 'pay_frequency' | 'income_mode'>>) {
  if (isDemo) {
    return local((s) => Object.assign(s.members.find((m) => m.user_id === userId)!, patch),
      (s) => `${me(s)} updated ${memberName(userId)}'s income settings`);
  }
  check(await supabase.from('members').update(patch).eq('user_id', userId));
  await reload();
}

export async function addPaycheck(memberId: string, amountCents: number, paidOn: string) {
  const s = getState();
  if (isDemo) {
    return local((s) => {
      s.paychecks.push({ id: newId(), household_id: s.household.id, member_id: memberId, amount_cents: amountCents, paid_on: paidOn });
      s.paychecks.sort((a, b) => b.paid_on.localeCompare(a.paid_on));
    }, (s) => `${me(s)} logged a ${formatCents(amountCents)} paycheck for ${memberName(memberId)}`);
  }
  check(await supabase.from('paychecks').insert({
    household_id: s.household.id, member_id: memberId, amount_cents: amountCents, paid_on: paidOn,
  }));
  await reload();
}

export async function deletePaycheck(id: string) {
  if (isDemo) {
    return local((s) => { s.paychecks = s.paychecks.filter((p) => p.id !== id); }, (s) => `${me(s)} removed a paycheck`);
  }
  check(await supabase.from('paychecks').delete().eq('id', id));
  await reload();
}

export async function updateHousehold(patch: Partial<Pick<Household, 'name' | 'weekly_mode' | 'income_window_months'>>) {
  if (isDemo) return local((s) => Object.assign(s.household, patch));
  check(await supabase.from('households').update(patch).eq('id', getState().household.id));
  await reload();
}

export async function requestOwnership(billId: string, kind: BillRequest['kind'], ownerId: string | null) {
  const s = getState();
  if (isDemo) {
    const name = s.bills.find((b) => b.id === billId)?.name;
    return local((s) => s.requests.unshift({
      id: newId(), household_id: s.household.id, bill_id: billId, kind, owner_id: ownerId,
      requested_by: s.userId, status: 'pending', created_at: new Date().toISOString(),
    }), (s) => `${me(s)} asked to make ${name} ${kind === 'make_personal' ? `personal (${memberName(ownerId)} pays all of it)` : 'shared again'}`);
  }
  check(await supabase.from('bill_requests').insert({
    household_id: s.household.id, bill_id: billId, kind, owner_id: ownerId, requested_by: s.userId,
  }));
  await reload();
}

export async function decideRequest(id: string, decision: 'approved' | 'declined' | 'cancelled') {
  if (isDemo) {
    const s = getState();
    const r = s.requests.find((x) => x.id === id)!;
    if (decision !== 'cancelled' && r.requested_by === s.userId) throw new Error('Your partner has to approve this, not you');
    const bill = s.bills.find((b) => b.id === r.bill_id)!;
    return local(() => {
      r.status = decision;
      if (decision === 'approved') bill.owner_id = r.kind === 'make_personal' ? r.owner_id : null;
    }, (s) => `${me(s)} ${decision} the request to make ${bill.name} ${r.kind === 'make_personal' ? 'personal' : 'shared'}`);
  }
  check(await supabase.rpc('decide_request', { p_request_id: id, p_decision: decision }));
  await reload();
}
