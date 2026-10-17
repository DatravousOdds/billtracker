// App-owner admin data. Every call is checked again in the database (supabase/admin.sql).
import { check } from './store';
import { supabase } from './supabase';
import type { ActivityEntry, Bill, Contribution, Household, Member, Payment, Paycheck } from './types';

export type Role = 'admin' | 'support';

export interface AdminUser {
  user_id: string;
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
  household_id: string | null;
  display_name: string | null;
  role: Role | null;
}

export interface AdminHousehold {
  bills: Bill[];
  payments: Payment[];
  contributions: Contribution[];
  paychecks: Paycheck[];
  activity: ActivityEntry[];
}

export type AdminTable = 'bills' | 'payments' | 'contributions' | 'paychecks';

/** The signed-in user's staff role, set at sign-in by main.ts. Only hides/shows UI; the database enforces access. */
export let role: Role | null = null;

export async function checkRole(): Promise<Role | null> {
  // Errors (e.g. admin.sql not run yet) just mean "no staff role".
  const { data, error } = await supabase.rpc('app_role');
  role = !error && (data === 'admin' || data === 'support') ? data : null;
  return role;
}

export async function loadUsers(): Promise<AdminUser[]> {
  return check(await supabase.rpc('admin_users')) as AdminUser[];
}

export async function setRole(userId: string, newRole: Role | 'user') {
  check(await supabase.rpc('admin_set_role', { p_user: userId, p_role: newRole }));
}

export async function loadOverview() {
  const [households, members, users] = await Promise.all([
    supabase.from('households').select('*').order('created_at', { ascending: false }),
    supabase.from('members').select('*').order('created_at'),
    loadUsers(),
  ]);
  return {
    households: check(households) as (Household & { created_at: string })[],
    members: check(members) as Member[],
    users,
  };
}

export async function loadHousehold(id: string): Promise<AdminHousehold> {
  const [bills, payments, contributions, paychecks, activity] = await Promise.all([
    supabase.from('bills').select('*').eq('household_id', id).order('name'),
    supabase.from('payments').select('*').eq('household_id', id).order('due_date', { ascending: false }),
    supabase.from('contributions').select('*').eq('household_id', id).order('week_start', { ascending: false }),
    supabase.from('paychecks').select('*').eq('household_id', id).order('paid_on', { ascending: false }),
    supabase.from('activity_log').select('id, actor, message, created_at').eq('household_id', id)
      .order('created_at', { ascending: false }).limit(100),
  ]);
  return {
    bills: check(bills) as Bill[],
    payments: check(payments) as Payment[],
    contributions: check(contributions) as Contribution[],
    paychecks: check(paychecks) as Paycheck[],
    activity: check(activity) as ActivityEntry[],
  };
}

export async function updateRow(table: AdminTable, id: string, patch: Record<string, unknown>) {
  // .select() so an update that matched no row (already deleted) is reported, not silently ignored.
  const rows = check(await supabase.from(table).update(patch).eq('id', id).select('id'));
  if (!rows.length) throw new Error('That row no longer exists');
}

export async function deleteRow(table: AdminTable, id: string) {
  check(await supabase.from(table).delete().eq('id', id));
}

export async function removeMember(userId: string) {
  check(await supabase.rpc('admin_remove_member', { p_user: userId }));
}

export async function deleteUser(userId: string) {
  check(await supabase.rpc('admin_delete_user', { p_user: userId }));
}

export async function deleteHousehold(id: string) {
  check(await supabase.rpc('admin_delete_household', { p_household: id }));
}

export async function resetInviteCode(id: string): Promise<string> {
  return check(await supabase.rpc('admin_reset_invite_code', { p_household: id })) as string;
}
