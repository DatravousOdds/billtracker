export type PayFrequency = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
export type Recurrence = 'once' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
export type WeeklyMode = 'smoothed' | 'due';
export type IncomeMode = 'fixed' | 'per_paycheck';
export type PaycheckAverage = 'auto' | 'per_paycheck';

/** Dates are plain calendar dates: 'YYYY-MM-DD'. */
export type ISODate = string;

export interface Household {
  id: string;
  name: string;
  invite_code: string;
  weekly_mode: WeeklyMode;
  /** Agreed split: split_member pays split_percent%. null = split by income. */
  split_member: string | null;
  split_percent: number | null;
  /** Waiting for the partner. A null percent with a proposer = back to income. */
  split_proposed_by: string | null;
  split_proposed_percent: number | null;
}

export interface Member {
  user_id: string;
  household_id: string;
  display_name: string;
  pay_amount_cents: number;
  pay_frequency: PayFrequency;
  income_mode: IncomeMode;
  paycheck_average: PaycheckAverage;
  /** Any one payday; the others follow from pay_frequency. null = deposit every week. */
  payday: ISODate | null;
  created_at: string;
}

export interface Bill {
  id: string;
  household_id: string;
  name: string;
  amount_cents: number;
  category: string;
  recurrence: Recurrence;
  start_date: ISODate;
  autopay: boolean;
  owner_id: string | null; // null = shared
  active: boolean;
  created_at: string;
}

export interface Payment {
  id: string;
  household_id: string;
  bill_id: string;
  due_date: ISODate;
  paid_on: ISODate;
  amount_cents: number;
  paid_by: string | null; // null = shared account
}

export interface Contribution {
  id: string;
  household_id: string;
  member_id: string;
  week_start: ISODate;
  amount_cents: number;
}

export interface Paycheck {
  id: string;
  household_id: string;
  member_id: string;
  amount_cents: number;
  paid_on: ISODate;
}

export interface BillRequest {
  id: string;
  household_id: string;
  bill_id: string;
  kind: 'make_personal' | 'make_shared';
  owner_id: string | null;
  requested_by: string;
  status: 'pending' | 'approved' | 'declined' | 'cancelled';
  created_at: string;
}

export interface ActivityEntry {
  id: number;
  actor: string | null;
  message: string;
  created_at: string;
}
