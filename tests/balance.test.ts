import { describe, expect, it } from 'vitest';
import { balanceEntry, balanceWeek, depositDue, incomeShares, type Share } from '../src/logic/split';
import type { AccountBalance, Bill, Contribution, Member, Payment } from '../src/types';

const m = (id: string, payday: string | null, f: Member['pay_frequency'] = 'biweekly', pay = 0): Member => ({
  user_id: id, household_id: 'h', display_name: id, pay_amount_cents: pay, pay_frequency: f, income_mode: 'fixed',
  paycheck_average: 'auto', payday, created_at: '',
});
const bill = (id: string, cents: number, start: string, extra: Partial<Bill> = {}): Bill => ({
  id, household_id: 'h', name: id, amount_cents: cents, category: 'x', recurrence: 'once', start_date: start,
  autopay: false, owner_id: null, active: true, created_at: '', ...extra,
});
const dep = (member_id: string, week_start: string, amount_cents: number): Contribution => ({ id: member_id + week_start, household_id: 'h', member_id, week_start, amount_cents });
const paid = (b: Bill, paid_on: string, paid_by: string | null = null): Payment => ({ id: b.id, household_id: 'h', bill_id: b.id, due_date: b.start_date, paid_on, amount_cents: b.amount_cents, paid_by });
const sharesOf = (a: Member, s: Member): Share[] => incomeShares([a, s], [], '2026-11-01', { split_member: a.user_id, split_percent: 40 });
const enter = (me: Member, cents: number, date: string, bills: Bill[], pays: Payment[], shares: Share[], cs: Contribution[], old: AccountBalance[] = [], week?: string): AccountBalance =>
  ({ id: 'x', household_id: 'h', member_id: me.user_id, entered_at: '', ...balanceEntry(me, cents, date, bills, pays, shares, cs, old, week) });

const internet = bill('internet', 6000, '2026-11-07');
const rent = bill('rent', 44000, '2026-11-07');
const phone = bill('phone', 10000, '2026-11-16');
const gym = bill('gym', 5000, '2026-11-28');
const bills = [internet, rent, phone, gym];
const sam = m('sam', '2026-10-30');
const samDep = dep('sam', '2026-10-25', 30000);

describe('every pay schedule', () => {
  const cases: [string, Member, number[]][] = [
    ['weekly', m('alex', '2026-11-06', 'weekly'), [20000]],
    ['biweekly', m('alex', '2026-11-06'), [20000, 4000]],
    ['semimonthly', m('alex', '2026-11-06', 'semimonthly'), [20000, 4000, 0]],
    ['monthly', m('alex', '2026-11-06', 'monthly'), [20000, 4000, 0, 2000, 0]],
  ];
  for (const [name, alex, weeks] of cases) {
    it(name, () => {
      const sh = sharesOf(alex, sam);
      expect(depositDue(alex, '2026-11-06', 'due', bills, [], sh, [samDep])).toMatchObject({ weekCents: weeks, balanceCents: null, creditCents: 0 });
      const row = enter(alex, 35000, '2026-11-06', bills, [], sh, [samDep]);
      expect(row).toMatchObject({ week_start: '2026-11-01', spare_cents: 5000 });
      const after = depositDue(alex, '2026-11-06', 'due', bills, [], sh, [samDep], [row]);
      expect(after).toMatchObject({ creditCents: 2000, balanceCents: 35000, cents: weeks.reduce((a, b) => a + b, 0) - 2000 });
    });
  }
  it('no payday: Sunday is the payday, this week only', () => {
    const alex = m('alex', null);
    const sh = sharesOf(alex, sam);
    const row = enter(alex, 35000, '2026-11-03', bills, [], sh, [samDep]);
    expect(row).toMatchObject({ week_start: '2026-11-01', spare_cents: 5000 });
    expect(depositDue(alex, '2026-11-03', 'due', bills, [], sh, [samDep], [row])).toMatchObject({ from: '2026-11-01', to: '2026-11-07', weeks: 1, weekCents: [20000], creditCents: 2000, cents: 18000 });
    expect(depositDue(alex, '2026-11-03', 'due', bills, [paid(rent, '2026-11-02')], sh, [samDep], [row]).cents).toBe(18000); // Monday: still counts
    expect(depositDue(alex, '2026-11-03', 'due', bills, [paid(rent, '2026-11-01')], sh, [samDep], [row]).weekCents).toEqual([2400]); // Sunday: drops
    expect(depositDue(alex, '2026-11-09', 'due', bills, [], sh, [samDep], [row])).toMatchObject({ balanceCents: null, creditCents: 0 });
  });
});

describe('the lock and the paid-after-payday rule', () => {
  const alex = m('alex', '2026-11-06');
  const sh = sharesOf(alex, sam);
  const row = enter(alex, 35000, '2026-11-06', bills, [], sh, [samDep]);
  it('paying bills after payday moves nothing, whoever paid', () => {
    expect(depositDue(alex, '2026-11-07', 'due', bills, [paid(rent, '2026-11-07'), paid(internet, '2026-11-08', 'sam')], sh, [samDep], [row]))
      .toMatchObject({ cents: 22000, creditCents: 2000, weekCents: [20000, 4000] });
  });
  it('paid on or before payday drops out; credit stays', () => {
    expect(depositDue(alex, '2026-11-06', 'due', bills, [paid(internet, '2026-11-06')], sh, [samDep], [row]))
      .toMatchObject({ weekCents: [17600, 4000], creditCents: 2000, cents: 19600 });
  });
  it('adding a bill changes the deposit', () => {
    expect(depositDue(alex, '2026-11-06', 'due', [...bills, bill('vet', 10000, '2026-11-09')], [], sh, [samDep], [row])).toMatchObject({ creditCents: 2000, cents: 26000 });
  });
  it('a partner editing their payday cannot move a locked credit', () => {
    const moved = sharesOf(alex, { ...sam, payday: '2026-11-06' });
    expect(depositDue(alex, '2026-11-06', 'due', bills, [], moved, [samDep], [row]).creditCents).toBe(2000);
  });
  it('undoing a payment or re-adding a deposit cannot move it either', () => {
    expect(depositDue(alex, '2026-11-06', 'due', bills, [], sh, [], [row]).creditCents).toBe(2000);
  });
  it('short adds, floor at 0', () => {
    const short = enter(alex, 25000, '2026-11-06', bills, [], sh, [samDep]);
    expect(depositDue(alex, '2026-11-06', 'due', bills, [], sh, [samDep], [short])).toMatchObject({ creditCents: -2000, cents: 26000 });
    const rich = enter(alex, 100000, '2026-11-06', bills, [], sh, [samDep]);
    expect(depositDue(alex, '2026-11-06', 'due', bills, [], sh, [samDep], [rich])).toMatchObject({ creditCents: 24000, cents: 0, balanceCents: 100000 });
  });
  it('new payday, schedule change, off-week: the entry stops counting', () => {
    expect(depositDue(alex, '2026-11-20', 'due', bills, [], sh, [samDep], [row])).toMatchObject({ balanceCents: null, creditCents: 0 });
    expect(depositDue({ ...alex, payday: '2026-11-13' }, '2026-11-13', 'due', bills, [], sh, [samDep], [row])).toMatchObject({ balanceCents: null, creditCents: 0 });
    expect(depositDue(alex, '2026-11-10', 'due', bills, [], sh, [samDep], [row])).toMatchObject({ cents: 0, weeks: 0, balanceCents: null });
  });
  it('partner gone: all of the frozen spare is theirs', () => {
    expect(depositDue(alex, '2026-11-06', 'due', bills, [], incomeShares([alex], [], '2026-11-06'), [], [row])).toMatchObject({ creditCents: 5000, cents: 55000 });
  });
  it('another partner balance does not count', () => {
    expect(depositDue(alex, '2026-11-06', 'due', bills, [], sh, [samDep], [{ ...row, member_id: 'sam' }]).creditCents).toBe(0);
  });
  it('smoothed ignores it', () => {
    expect(depositDue(alex, '2026-11-06', 'smoothed', bills, [], sh, [samDep], [row])).toMatchObject({ creditCents: 0, balanceCents: null });
  });
});

describe('editing (history)', () => {
  const alex = m('alex', '2026-11-06');
  const sh = sharesOf(alex, sam);
  const pays = [paid(rent, '2026-11-07'), paid(internet, '2026-11-07')];
  const row = enter(alex, 35000, '2026-11-06', bills, [], sh, [samDep]);
  it('the same number does not re-freeze; a new one does', () => {
    expect(enter(alex, 35000, '2026-11-07', bills, pays, sh, [samDep], [row]).spare_cents).toBe(5000);
    expect(enter(alex, 35100, '2026-11-07', bills, pays, sh, [samDep], [row]).spare_cents).toBe(35100);
  });
  it('an edit after depositing gives the same spare', () => {
    expect(enter(alex, 57000, '2026-11-06', bills, [], sh, [samDep, dep('alex', '2026-11-01', 22000)], [row]).spare_cents).toBe(5000);
  });
  it('an older entry only corrects the record', () => {
    const old = enter(alex, 41000, '2026-10-23', bills, [], sh, []);
    expect(old.week_start).toBe('2026-10-18');
    const fixed = enter(alex, 40000, '2026-11-06', bills, pays, sh, [samDep], [old, row], '2026-10-18');
    expect(fixed).toMatchObject({ week_start: '2026-10-18', amount_cents: 40000, spare_cents: old.spare_cents });
    expect(depositDue(alex, '2026-11-06', 'due', bills, [], sh, [samDep], [fixed, row]).cents).toBe(22000);
  });
  it('in use: this payday week, else the last payday week; no payday: this week', () => {
    expect(balanceWeek(alex, '2026-11-02')).toBe('2026-11-01'); // the card asks all week
    expect(balanceWeek(alex, '2026-11-10')).toBe('2026-11-01'); // between paydays
    expect(balanceWeek(alex, '2026-11-20')).toBe('2026-11-15');
    expect(balanceWeek(m('a', null), '2026-11-10')).toBe('2026-11-08');
  });
});

describe('double charge', () => {
  const x = bill('x', 10000, '2026-11-01');
  const alex = m('alex', '2026-11-06');
  const sh = sharesOf(alex, sam);
  const cs = [dep('alex', '2026-10-18', 4000), dep('sam', '2026-10-25', 6000)];
  it('funded by my earlier deposit: not asked again, still held', () => {
    expect(depositDue(alex, '2026-11-06', 'due', [x], [], sh, cs)).toMatchObject({ overdueCents: 0, cents: 0 });
    expect(enter(alex, 10000, '2026-11-06', [x], [], sh, cs).spare_cents).toBe(0);
  });
  it('not funded: asked as overdue, not held', () => {
    const noMine = [dep('sam', '2026-10-25', 6000)];
    expect(depositDue(alex, '2026-11-06', 'due', [x], [], sh, noMine)).toMatchObject({ overdueCents: 4000 });
    expect(enter(alex, 6000, '2026-11-06', [x], [], sh, noMine).spare_cents).toBe(0);
  });
  it('partly funded: asked for the rest', () => {
    expect(depositDue(alex, '2026-11-06', 'due', [x], [], sh, [dep('alex', '2026-10-18', 1000), dep('sam', '2026-10-25', 6000)])).toMatchObject({ overdueCents: 3000 });
  });
  it('overdue stays put when the bill is paid after payday', () => {
    expect(depositDue(alex, '2026-11-07', 'due', [x], [paid(x, '2026-11-08')], sh, [dep('sam', '2026-10-25', 6000)])).toMatchObject({ overdueCents: 4000 });
  });
  it('autopay past its date counts as paid, not held', () => {
    const auto = bill('a', 10000, '2026-11-01', { autopay: true });
    expect(depositDue(alex, '2026-11-06', 'due', [auto], [], sh, [])).toMatchObject({ overdueCents: 0 });
    expect(enter(alex, 0, '2026-11-06', [auto], [], sh, [dep('alex', '2026-10-18', 4000)]).spare_cents).toBe(0);
  });
});

describe('both partners', () => {
  it('same day: the second still gets 60 of 100', () => {
    const r = bill('r', 50000, '2026-11-09');
    const alex = m('alex', '2026-11-06');
    const s = m('sam', '2026-11-06');
    const sh = sharesOf(alex, s);
    const a = enter(alex, 10000, '2026-11-06', [r], [], sh, []);
    expect(depositDue(alex, '2026-11-06', 'due', [r], [], sh, [], [a])).toMatchObject({ creditCents: 4000, cents: 16000 });
    const cs = [dep('alex', '2026-11-01', 16000)];
    const b = enter(s, 26000, '2026-11-06', [r], [], sh, cs);
    expect(b.spare_cents).toBe(10000);
    expect(depositDue(s, '2026-11-06', 'due', [r], [], sh, cs, [b])).toMatchObject({ creditCents: 6000, cents: 24000 });
  });
  it('next payday: Sam gets $30 and the account ends holding the phone bill', () => {
    const alex = m('alex', '2026-11-06');
    const sh = sharesOf(alex, sam);
    const three = [internet, rent, phone];
    const pays = [paid(rent, '2026-11-08'), paid(internet, '2026-11-08')];
    const cs = [samDep, dep('alex', '2026-11-01', 22000)];
    const row = enter(sam, 7000, '2026-11-13', three, pays, sh, cs);
    expect(row.spare_cents).toBe(5000);
    expect(depositDue(sam, '2026-11-13', 'due', three, pays, sh, cs, [row])).toMatchObject({ creditCents: 3000, cents: 3000 });
  });
});

describe('paycheck cap', () => {
  it('the credit comes off first, the cap applies last', () => {
    const alex = m('alex', '2026-11-06', 'biweekly', 80000);
    const big = bill('big', 225000, '2026-11-09');
    const sh = sharesOf(alex, sam);
    const row: AccountBalance = { id: 'x', household_id: 'h', member_id: 'alex', week_start: '2026-11-01', amount_cents: 5000, spare_cents: 5000, entered_at: '' };
    expect(depositDue(alex, '2026-11-06', 'due', [big], [], sh, [], [row])).toMatchObject({ creditCents: 2000, cents: 80000, limitCents: 80000, shortCents: 8000 });
  });
});
