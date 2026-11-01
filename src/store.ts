import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type {
  AccountBalance, ActivityEntry, Bill, BillRequest, Contribution, Household, ISODate, Member, Payment, Paycheck,
} from './types';
import { formatShort, todayISO } from './logic/dates';
import { balanceEntry, depositDue, incomeShares, type DepositDue, type Share } from './logic/split';
import { formatCents } from './logic/money';
import { demoLog, demoState, isDemo, newId } from './demo';

export interface State {
  userId: string;
  household: Household;
  members: Member[];
  bills: Bill[];
  payments: Payment[];
  contributions: Contribution[];
  accountBalances: AccountBalance[];
  paychecks: Paycheck[];
  requests: BillRequest[];
  activity: ActivityEntry[];
}

let state: State | null = null;
let channel: RealtimeChannel | null = null;
const listeners = new Set<() => void>();
// Bumped on every change: state is mutated in place, so React watches this number instead.
let version = 0;
export const getVersion = () => version;

/** State, or null while signed out or loading. */
export const peekState = () => state;

export function getState(): State {
  if (!state) throw new Error('Not loaded');
  return state;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  version++;
  listeners.forEach((fn) => fn());
}

export function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

/** Is the signed-in user in a household yet? Returns its id or null. */
export async function findMyHousehold(userId: string): Promise<string | null> {
  const row = check(await supabase.from('members').select('household_id').eq('user_id', userId).maybeSingle());
  return row ? (row as { household_id: string }).household_id : null;
}

/** Load everything for the household. Filtered explicitly: RLS lets admins read every household. */
export async function load(userId: string, householdId: string): Promise<void> {
  const [household, members, bills, payments, contributions, accountBalances, paychecks, requests, activity] = await Promise.all([
    supabase.from('households').select('*').eq('id', householdId).single(),
    supabase.from('members').select('*').eq('household_id', householdId).order('created_at'),
    supabase.from('bills').select('*').eq('household_id', householdId).order('name'),
    supabase.from('payments').select('*').eq('household_id', householdId),
    supabase.from('contributions').select('*').eq('household_id', householdId).order('week_start', { ascending: false }).order('created_at', { ascending: false }),
    supabase.from('account_balances').select('*').eq('household_id', householdId).order('entered_at', { ascending: false }),
    supabase.from('paychecks').select('*').eq('household_id', householdId).order('paid_on', { ascending: false }),
    supabase.from('bill_requests').select('*').eq('household_id', householdId).order('created_at', { ascending: false }),
    supabase.from('activity_log').select('id, actor, message, created_at').eq('household_id', householdId).order('created_at', { ascending: false }).limit(200),
  ]);
  state = {
    userId,
    household: check(household) as Household,
    members: check(members) as Member[],
    bills: check(bills) as Bill[],
    payments: check(payments) as Payment[],
    contributions: check(contributions) as Contribution[],
    accountBalances: check(accountBalances) as AccountBalance[],
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
    timer = window.setTimeout(() => {
      if (!channel) return;
      // shortcut: partner updates wait until the open form closes so a reload can't unmount its row. Upgrade if a form ever needs live data.
      if (document.querySelector('dialog[open]')) refresh();
      else load(userId, householdId).catch(console.error);
    }, 250);
  };
  channel = supabase.channel(`household-${householdId}`);
  const tables = ['members', 'bills', 'payments', 'contributions', 'account_balances', 'paychecks', 'bill_requests', 'activity_log'];
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
  // The write already committed. Failing here would invite a retry that duplicates it; realtime catches the screen up.
  await load(s.userId, s.household.id).catch(console.error);
}

// ---------- Derived ----------

export function shares(): Share[] {
  const s = getState();
  return incomeShares(s.members, s.paychecks, todayISO(), s.household);
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

export async function leaveHousehold() {
  check(await supabase.rpc('leave_household'));
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
  if (id) {
    const rows = check(await supabase.from('bills').update(input).eq('id', id).select('id'));
    if (!rows.length) throw new Error('That bill was removed');
  } else check(await supabase.from('bills').insert({ ...input, household_id: s.household.id }));
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
  const res = await supabase.from('payments').insert({
    household_id: s.household.id, bill_id: bill.id, due_date: dueDate,
    amount_cents: amountCents, paid_by: paidBy, paid_on: paidOn,
  });
  if (res.error?.code === '23505') throw new Error('This date was already confirmed paid');
  if (res.error?.code === '23503') throw new Error('That bill was removed');
  check(res);
  await reload();
}

export type PaymentEdit = Pick<Payment, 'amount_cents' | 'paid_on' | 'paid_by'>;

export async function updatePayment(id: string, edit: PaymentEdit) {
  if (isDemo) {
    const s = getState();
    const old = s.payments.find((p) => p.id === id);
    if (!old) throw new Error('That payment was removed');
    const billName = s.bills.find((b) => b.id === old.bill_id)?.name;
    const changes: string[] = [];
    if (edit.amount_cents !== old.amount_cents) changes.push(`${formatCents(old.amount_cents)} → ${formatCents(edit.amount_cents)}`);
    if (edit.paid_on !== old.paid_on) changes.push(`paid on ${formatShort(old.paid_on)} → ${formatShort(edit.paid_on)}`);
    if (edit.paid_by !== old.paid_by) changes.push(`paid from ${memberName(old.paid_by)} → ${memberName(edit.paid_by)}`);
    return local(() => Object.assign(old, edit),
      changes.length ? (s) => `${me(s)} edited ${billName} (due ${formatShort(old.due_date)}): ${changes.join(', ')}` : undefined);
  }
  const rows = check(await supabase.from('payments').update(edit).eq('id', id).select('id'));
  if (!rows.length) throw new Error('That payment was removed');
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

/** Save the balance the signed-in partner typed: the one in use, or `week`'s. Returns their deposit with it applied. */
export async function saveBalance(cents: number, week?: ISODate): Promise<DepositDue> {
  // The spare money is frozen from this state, so a phone that missed a partner's deposit would keep a wrong credit all period.
  if (!isDemo) await reload();
  const s = getState();
  const memberId = s.userId;
  const today = todayISO();
  const member = s.members.find((m) => m.user_id === memberId)!;
  const entry = balanceEntry(member, cents, today, s.bills, s.payments, shares(), s.contributions, s.accountBalances, week);
  if (isDemo) {
    const old = s.accountBalances.find((b) => b.member_id === memberId && b.week_start === entry.week_start);
    const was = old?.amount_cents;
    local((s) => {
      if (old) Object.assign(old, entry);
      else s.accountBalances.unshift({ ...entry, id: newId(), household_id: s.household.id, member_id: memberId, entered_at: new Date().toISOString() });
    }, was === cents ? undefined : (s) => (was === undefined
      ? `${me(s)} entered the bill account balance: ${formatCents(cents)}`
      : `${me(s)} changed the bill account balance: ${formatCents(was)} → ${formatCents(cents)}`));
  } else {
    check(await supabase.from('account_balances').upsert({ household_id: s.household.id, member_id: memberId, ...entry }, { onConflict: 'member_id,week_start' }));
    await reload();
  }
  const now = getState();
  return depositDue(now.members.find((m) => m.user_id === memberId) ?? member, today, now.household.weekly_mode, now.bills, now.payments, shares(), now.contributions, now.accountBalances);
}

export async function updateMember(userId: string, patch: Partial<Pick<Member, 'display_name' | 'pay_amount_cents' | 'pay_frequency' | 'income_mode' | 'paycheck_average' | 'payday'>>) {
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

export async function updateHousehold(patch: Partial<Pick<Household, 'name' | 'weekly_mode'>>) {
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

/** Ask your partner to approve a split where you pay `percent`% (null = back to income). */
export async function proposeSplit(percent: number | null) {
  if (isDemo) {
    const s = getState();
    if (s.household.split_proposed_by && s.household.split_proposed_by !== s.userId) {
      throw new Error('Your partner already asked for a split change. Approve or decline it first.');
    }
    return local((s) => Object.assign(s.household, { split_proposed_by: s.userId, split_proposed_percent: percent }),
      (s) => `${me(s)} asked to ${percent === null ? 'go back to splitting bills by income' : `split shared bills ${percent}/${100 - percent}`}`);
  }
  check(await supabase.rpc('propose_split', { p_percent: percent }));
  await reload();
}

export async function decideSplit(decision: 'approved' | 'declined' | 'cancelled') {
  if (isDemo) {
    const h = getState().household;
    if (decision !== 'cancelled' && h.split_proposed_by === getState().userId) throw new Error('Your partner has to approve this, not you');
    const p = h.split_proposed_percent;
    return local(() => {
      if (decision === 'approved') Object.assign(h, { split_member: p === null ? null : h.split_proposed_by, split_percent: p });
      Object.assign(h, { split_proposed_by: null, split_proposed_percent: null });
    }, (s) => `${me(s)} ${decision} the ${p === null ? 'request to split bills by income' : `${p}/${100 - p} bill split`}`);
  }
  check(await supabase.rpc('decide_split', { p_decision: decision }));
  await reload();
}
