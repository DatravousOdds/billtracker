// Demo mode: sample data kept in memory so you can click through the app
// without a Supabase project. Nothing is saved; reloading resets it.
// Enabled by building with VITE_DEMO=1 (npm run build:demo).
import { addDays, addMonths, todayISO, weekStart } from './logic/dates';
import { formatCents } from './logic/money';
import type { State } from './store';
import { occurrences } from './logic/split';
import type { ActivityEntry, Bill, BillRequest, Member, Payment } from './types';

export const isDemo = import.meta.env.VITE_DEMO === '1';

const ALEX = 'demo-alex';
const SAM = 'demo-sam';
const H = 'demo-household';
let seq = 1;
export const newId = () => `demo-${seq++}`;

/** Day-of-month in the current month, as a date string. */
function thisMonth(day: number): string {
  const t = todayISO();
  return `${t.slice(0, 8)}${String(day).padStart(2, '0')}`;
}

export function demoState(): State {
  const today = todayISO();
  const wk = weekStart(today);
  const start = (day: number) => addMonths(thisMonth(day), -6);

  const members: Member[] = [
    { user_id: ALEX, household_id: H, display_name: 'Alex', pay_amount_cents: 200000, pay_frequency: 'biweekly', income_mode: 'fixed', paycheck_average: 'auto', created_at: '1' },
    { user_id: SAM, household_id: H, display_name: 'Sam', pay_amount_cents: 65000, pay_frequency: 'weekly', income_mode: 'per_paycheck', paycheck_average: 'auto', created_at: '2' },
  ];

  const b = (name: string, cents: number, category: string, recurrence: Bill['recurrence'], start_date: string, extra: Partial<Bill> = {}): Bill => ({
    id: newId(), household_id: H, name, amount_cents: cents, category, recurrence, start_date,
    autopay: false, owner_id: null, active: true, created_at: addDays(today, -75) + 'T12:00:00Z', ...extra,
  });

  const bills: Bill[] = [
    b('Rent', 140000, 'Housing', 'monthly', start(1)),
    b('Electric', 13500, 'Utilities', 'monthly', start(18)),
    b('Water', 6000, 'Utilities', 'monthly', start(9)),
    b('Internet', 7000, 'Phone & Internet', 'monthly', start(14), { autopay: true }),
    b('Phones', 12000, 'Phone & Internet', 'monthly', start(22)),
    b('Streaming', 1549, 'Subscriptions', 'monthly', start(15), { autopay: true }),
    b('Car insurance', 48000, 'Insurance', 'quarterly', addMonths(thisMonth(28), -9)),
    b("Renter's insurance", 18000, 'Insurance', 'yearly', addMonths(thisMonth(5), -10)),
    b('Vet visit', 18000, 'Other', 'once', addDays(today, 3)),
    b('Car payment', 32000, 'Transportation', 'monthly', start(13), { owner_id: SAM }),
    b('Gym', 4500, 'Subscriptions', 'monthly', start(20)),
  ];
  const id = (name: string) => bills.find((x) => x.name === name)!.id;

  const requests: BillRequest[] = [
    { id: newId(), household_id: H, bill_id: id('Gym'), kind: 'make_personal', owner_id: ALEX, requested_by: SAM, status: 'pending', created_at: new Date().toISOString() },
  ];

  const paychecks = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => ({
    id: newId(), household_id: H, member_id: SAM, amount_cents: [65000, 61250, 70500, 65000][i % 4], paid_on: addDays(today, -2 - i * 7),
  }));

  const contributions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap((w) => [
    { id: newId(), household_id: H, member_id: ALEX, week_start: addDays(wk, -7 * w), amount_cents: 33500 },
    { id: newId(), household_id: H, member_id: SAM, week_start: addDays(wk, -7 * w), amount_cents: w === 1 ? 15000 : 21800 },
  ]);

  // Everything due before today is paid, except this month's water bill (shows as overdue).
  const payments: Payment[] = occurrences(bills, [], addDays(today, -75), addDays(today, -1))
    .filter((o) => !(o.bill.name === 'Water' && o.date === thisMonth(9)))
    .map((o) => ({
      id: newId(), household_id: H, bill_id: o.bill.id, due_date: o.date, paid_on: o.date,
      amount_cents: o.bill.amount_cents,
      paid_by: o.bill.owner_id ?? (o.bill.name === 'Electric' ? ALEX : null),
    }));

  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const activity: ActivityEntry[] = [
    { id: 5, actor: SAM, message: 'Sam asked to make Gym personal (Alex pays all of it)', created_at: ago(40) },
    { id: 4, actor: SAM, message: `Sam logged a ${formatCents(65000)} paycheck for Sam`, created_at: ago(60 * 26) },
    { id: 3, actor: ALEX, message: `Alex edited Electric: ${formatCents(12000)} → ${formatCents(13500)}`, created_at: ago(60 * 50) },
    { id: 2, actor: ALEX, message: 'Alex marked Rent paid from the shared account', created_at: ago(60 * 24 * 9) },
    { id: 1, actor: SAM, message: 'Sam joined the household', created_at: ago(60 * 24 * 40) },
  ];

  return {
    userId: ALEX,
    household: { id: H, name: 'Alex & Sam', invite_code: 'K7Q2MX', weekly_mode: 'smoothed',
      split_member: null, split_percent: null, split_proposed_by: null, split_proposed_percent: null },
    members, bills, payments, contributions, paychecks, requests, activity,
  };
}

let activityId = 100;
/** Add an activity-log line the way the database triggers would. */
export function demoLog(s: State, message: string) {
  s.activity.unshift({ id: activityId++, actor: s.userId, message, created_at: new Date().toISOString() });
}
