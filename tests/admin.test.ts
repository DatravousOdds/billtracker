// Runs the real Supabase SQL in an in-memory Postgres (PGlite) and checks who can do what.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { beforeAll, describe, expect, it } from 'vitest';
import schemaSql from '../supabase/schema.sql?raw';
import leaveSql from '../supabase/leave.sql?raw';
import adminSql from '../supabase/admin.sql?raw';
import paycheckAverageSql from '../supabase/paycheck-average.sql?raw';
import ownIncomeSql from '../supabase/own-income.sql?raw';
import customSplitSql from '../supabase/custom-split.sql?raw';
import payScheduleSql from '../supabase/pay-schedule.sql?raw';
import depositCreditSql from '../supabase/deposit-credit.sql?raw';
import paymentEditsSql from '../supabase/payment-edits.sql?raw';
import accountBalanceSql from '../supabase/account-balance.sql?raw';

// The bits of Supabase the schema relies on: API roles, auth.users, auth.uid(), default grants.
const SUPABASE_STUB = `
  create role anon nologin;
  create role service_role nologin;
  create role authenticated nologin;
  create schema auth;
  create schema extensions;
  create table auth.users (id uuid primary key, email text, created_at timestamptz default now(), last_sign_in_at timestamptz);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth, extensions to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  create publication supabase_realtime;
`;

let db: PGlite;

async function as(userId: string | null) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
  if (userId) await db.exec('set role authenticated');
}

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function newUser(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await as(null);
  await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${name.toLowerCase()}-${id.slice(0, 6)}@test.dev`]);
  return id;
}

/** A household whose first name creates it and the rest join with the invite code. */
async function household(...names: string[]) {
  const ids = [];
  for (const n of names) ids.push(await newUser(n));
  await as(ids[0]);
  const [{ id: hid }] = await rows<{ id: string }>('select public.create_household($1, $2) as id', ['Home', names[0]]);
  await as(null);
  const [{ invite_code }] = await rows<{ invite_code: string }>('select invite_code from households where id = $1', [hid]);
  for (let i = 1; i < ids.length; i++) {
    await as(ids[i]);
    await db.query('select public.join_household($1, $2)', [invite_code, names[i]]);
  }
  return { hid, ids };
}

async function addBill(userId: string, hid: string, name = 'Rent') {
  await as(userId);
  const [{ id }] = await rows<{ id: string }>(
    `insert into bills (household_id, name, amount_cents, start_date) values ($1, $2, 100000, '2026-01-01') returning id`, [hid, name]);
  return id;
}

async function addDeposit(userId: string, hid: string) {
  await as(userId);
  await db.query(`insert into contributions (household_id, member_id, week_start, amount_cents) values ($1, $2, '2026-10-11', 5000)`, [hid, userId]);
}

async function grant(userId: string, role: 'admin' | 'support') {
  await as(null);
  await db.query('insert into app_roles (user_id, role) values ($1, $2)', [userId, role]);
}

async function count(sql: string, params: unknown[] = []) {
  await as(null);
  const [{ n }] = await rows<{ n: number }>(`select count(*)::int as n from ${sql}`, params);
  return n;
}

beforeAll(async () => {
  db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUB);
  for (const sql of [schemaSql, leaveSql, adminSql, paycheckAverageSql, paycheckAverageSql, ownIncomeSql, ownIncomeSql, customSplitSql, customSplitSql, paymentEditsSql, paymentEditsSql, payScheduleSql, accountBalanceSql, accountBalanceSql, depositCreditSql, depositCreditSql]) await db.exec(sql);
}, 60_000);

describe('normal users', () => {
  it('only see their own household and cannot call admin functions', async () => {
    const a = await household('Alex', 'Sam');
    const b = await household('Kim');
    await addBill(b.ids[0], b.hid);

    await as(a.ids[0]);
    expect(await rows('select id from households')).toEqual([{ id: a.hid }]);
    expect(await rows('select id from bills where household_id = $1', [b.hid])).toEqual([]);
    expect(await rows<{ role: string | null }>('select public.app_role() as role')).toEqual([{ role: null }]);
    await expect(db.query('select * from public.admin_users()')).rejects.toThrow('Not allowed');
    await expect(db.query('select public.admin_set_role($1, $2)', [a.ids[0], 'admin'])).rejects.toThrow('Not allowed');
    await expect(db.query('select public.admin_delete_household($1)', [b.hid])).rejects.toThrow('Not allowed');
  });

  it('cannot call the internal delete helpers or read roles directly', async () => {
    const a = await household('Alex');
    await as(a.ids[0]);
    await expect(db.query('select public.remove_member($1, $2)', [a.ids[0], 'x'])).rejects.toThrow(/permission denied/);
    await expect(db.query('select public.delete_household_data($1)', [a.hid])).rejects.toThrow(/permission denied/);
    await expect(db.query('select * from app_roles')).rejects.toThrow(/permission denied/);
  });
});

describe('support', () => {
  it('can read every household and reset invite codes, but not change data', async () => {
    const support = await newUser('Sup');
    await grant(support, 'support');
    const h = await household('Alex');
    const bill = await addBill(h.ids[0], h.hid);

    await as(support);
    expect(await rows('select id from bills where id = $1', [bill])).toHaveLength(1);
    expect((await db.query('update bills set amount_cents = 1 where id = $1', [bill])).affectedRows).toBe(0);
    expect((await db.query('delete from bills where id = $1', [bill])).affectedRows).toBe(0);
    await expect(db.query('select public.admin_delete_household($1)', [h.hid])).rejects.toThrow('Not allowed');
    await expect(db.query('select public.admin_set_role($1, $2)', [h.ids[0], 'support'])).rejects.toThrow('Not allowed');

    const [{ code }] = await rows<{ code: string }>('select public.admin_reset_invite_code($1) as code', [h.hid]);
    expect(code).toMatch(/^[0-9A-F]{6}$/);
    expect(await count('bills where id = $1 and amount_cents = 100000', [bill])).toBe(1);
  });
});

describe('admins', () => {
  it('manage roles but never their own', async () => {
    const admin = await newUser('Root');
    await grant(admin, 'admin');
    const other = await newUser('Pat');

    await as(admin);
    await expect(db.query('select public.admin_set_role($1, $2)', [admin, 'user'])).rejects.toThrow('own role');
    await db.query('select public.admin_set_role($1, $2)', [other, 'support']);
    const [me] = await rows<{ role: string }>('select role from public.admin_users() where user_id = $1', [other]);
    expect(me.role).toBe('support');
    await db.query('select public.admin_set_role($1, $2)', [other, 'user']);
    expect(await count('app_roles where user_id = $1', [other])).toBe(0);
  });

  it('removing one partner keeps the household, frees their bills and logs one line', async () => {
    const admin = await newUser('Root');
    await grant(admin, 'admin');
    const h = await household('Alex', 'Sam');
    const bill = await addBill(h.ids[0], h.hid);
    await addDeposit(h.ids[1], h.hid);
    await as(null);
    await db.exec(`begin; select set_config('app.approved_owner_change', 'on', true);
                   update bills set owner_id = '${h.ids[1]}' where id = '${bill}'; commit;`);

    await as(admin);
    await db.query('select public.admin_remove_member($1)', [h.ids[1]]);

    expect(await count('households where id = $1', [h.hid])).toBe(1);
    expect(await count('members where user_id = $1', [h.ids[1]])).toBe(0);
    expect(await count('contributions where member_id = $1', [h.ids[1]])).toBe(0);
    expect(await count('bills where id = $1 and owner_id is null', [bill])).toBe(1);
    const log = (await rows<{ message: string }>('select message from activity_log where household_id = $1', [h.hid])).map((r) => r.message);
    expect(log).toContain('Sam was removed by an admin');
    expect(log.some((m) => m.includes('deposit'))).toBe(false);
  });

  it('deleting the last member deletes the household, so its old invite code shows nothing', async () => {
    const admin = await newUser('Root');
    await grant(admin, 'admin');
    const h = await household('Kim');
    await addBill(h.ids[0], h.hid);

    await as(admin);
    await db.query('select public.admin_delete_user($1)', [h.ids[0]]);

    expect(await count('auth.users where id = $1', [h.ids[0]])).toBe(0);
    expect(await count('households where id = $1', [h.hid])).toBe(0);
    expect(await count('bills where household_id = $1', [h.hid])).toBe(0);
  });

  it('can edit any row, including another user\'s deposit', async () => {
    const admin = await newUser('Root');
    await grant(admin, 'admin');
    const h = await household('Alex');
    await addDeposit(h.ids[0], h.hid);

    await as(admin);
    const res = await db.query('update contributions set amount_cents = 7000 where member_id = $1', [h.ids[0]]);
    expect(res.affectedRows).toBe(1);
  });
});

describe('leaving', () => {
  it('the last partner out deletes the household', async () => {
    const h = await household('Alex', 'Sam');
    await as(h.ids[1]);
    await db.query('select public.leave_household()');
    expect(await count('households where id = $1', [h.hid])).toBe(1);
    await as(h.ids[0]);
    await db.query('select public.leave_household()');
    expect(await count('households where id = $1', [h.hid])).toBe(0);
  });

  it('changes the invite code, so whoever left cannot rejoin with the old one', async () => {
    const h = await household('Alex', 'Sam');
    const [{ invite_code: old }] = await rows<{ invite_code: string }>('select invite_code from households where id = $1', [h.hid]);
    await as(h.ids[1]);
    await db.query('select public.leave_household()');
    await expect(db.query('select public.join_household($1, $2)', [old, 'Sam'])).rejects.toThrow('Invite code not found');
    await as(null);
    const [{ invite_code: now }] = await rows<{ invite_code: string }>('select invite_code from households where id = $1', [h.hid]);
    expect(now).toMatch(/^[0-9A-F]{6}$/);
  });
});

describe('paycheck-average.sql', () => {
  it('lets a partner choose how their average is calculated, and nothing else', async () => {
    const h = await household('Alex', 'Sam');
    await as(h.ids[0]);
    expect(await rows('select paycheck_average from members where user_id = $1', [h.ids[0]])).toEqual([{ paycheck_average: 'auto' }]);
    await db.query(`update members set paycheck_average = 'per_paycheck' where user_id = $1`, [h.ids[0]]);
    expect(await rows('select paycheck_average from members where user_id = $1', [h.ids[0]])).toEqual([{ paycheck_average: 'per_paycheck' }]);
    await expect(db.query(`update members set paycheck_average = 'weekly' where user_id = $1`, [h.ids[0]])).rejects.toThrow(/check constraint/);
    await db.query(`update members set paycheck_average = 'per_paycheck', display_name = 'Sammy' where user_id = $1`, [h.ids[0]]); // unchanged: no log
    expect(await count(`activity_log where household_id = $1 and message like '%paycheck average%'`, [h.hid])).toBe(1);
  });
});

describe('admin.sql', () => {
  it('refuses to install before leave.sql', async () => {
    const fresh = await PGlite.create({ extensions: { pgcrypto } });
    await fresh.exec(SUPABASE_STUB);
    await fresh.exec(schemaSql);
    await expect(fresh.exec(adminSql)).rejects.toThrow('Run supabase/leave.sql before admin.sql');
    await fresh.close();
  }, 60_000);
});

describe('own-income.sql', () => {
  it('lets each partner change only their own income and paychecks, but see both', async () => {
    const h = await household('Alex', 'Sam');
    const [alex, sam] = h.ids;
    await as(sam);
    await db.query(`insert into paychecks (household_id, member_id, amount_cents, paid_on) values ($1, $2, 65000, '2026-10-16')`, [h.hid, sam]);

    await as(alex);
    expect((await db.query('update members set pay_amount_cents = 200000 where user_id = $1', [alex])).affectedRows).toBe(1);
    expect((await db.query('update members set pay_amount_cents = 1 where user_id = $1', [sam])).affectedRows).toBe(0);
    await expect(db.query(`insert into paychecks (household_id, member_id, amount_cents, paid_on) values ($1, $2, 1, '2026-10-16')`, [h.hid, sam]))
      .rejects.toThrow(/row-level security/);
    await db.query(`insert into paychecks (household_id, member_id, amount_cents, paid_on) values ($1, $2, 200000, '2026-10-16')`, [h.hid, alex]);
    expect((await db.query('delete from paychecks where member_id = $1', [sam])).affectedRows).toBe(0);
    expect(await rows('select member_id from paychecks where household_id = $1', [h.hid])).toHaveLength(2);

    await as(sam);
    expect(await rows('select member_id from paychecks where household_id = $1', [h.hid])).toHaveLength(2);
    expect(await count('members where user_id = $1 and pay_amount_cents = 200000', [alex])).toBe(1);
    expect(await count('members where user_id = $1 and pay_amount_cents = 0', [sam])).toBe(1);
  });
});

describe('custom-split.sql', () => {
  const split = async (hid: string) => (await rows(
    'select split_member, split_percent, split_proposed_by, split_proposed_percent from households where id = $1', [hid]))[0];

  it('only changes the split once the other partner approves', async () => {
    const h = await household('Alex', 'Sam');
    const [alex, sam] = h.ids;
    await as(alex);
    await expect(db.query('update households set split_percent = 60 where id = $1', [h.hid])).rejects.toThrow(/permission denied/);
    await expect(db.query('select public.propose_split(100)')).rejects.toThrow('between 1 and 99');
    await db.query('select public.propose_split(60)');
    await expect(db.query(`select public.decide_split('approved')`)).rejects.toThrow('Your partner has to approve');
    await as(null);
    expect(await split(h.hid)).toEqual({ split_member: null, split_percent: null, split_proposed_by: alex, split_proposed_percent: 60 });

    await as(sam);
    await expect(db.query('select public.propose_split(50)')).rejects.toThrow('already asked');
    await expect(db.query(`select public.decide_split('cancelled')`)).rejects.toThrow('Only the requester');
    await db.query(`select public.decide_split('approved')`);
    await as(null);
    expect(await split(h.hid)).toEqual({ split_member: alex, split_percent: 60, split_proposed_by: null, split_proposed_percent: null });

    // Back to income also needs approval; declining keeps the agreed split.
    await as(sam);
    await db.query('select public.propose_split(null)');
    await as(alex);
    await db.query(`select public.decide_split('declined')`);
    await as(null);
    expect(await split(h.hid)).toMatchObject({ split_member: alex, split_percent: 60, split_proposed_by: null });
    expect(await count(`activity_log where household_id = $1 and message like '%split%'`, [h.hid])).toBe(4);
  });

  it('needs a partner, and a partner leaving resets the split', async () => {
    const solo = await household('Kim');
    await as(solo.ids[0]);
    await expect(db.query('select public.propose_split(60)')).rejects.toThrow('partner needs to join');

    const h = await household('Alex', 'Sam');
    await as(h.ids[0]);
    await db.query('select public.propose_split(70)');
    await as(h.ids[1]);
    await db.query(`select public.decide_split('approved')`);
    await db.query('select public.leave_household()');
    await as(null);
    expect(await split(h.hid)).toEqual({ split_member: null, split_percent: null, split_proposed_by: null, split_proposed_percent: null });
  });
});

describe('payment-edits.sql', () => {
  /** A $1,000.00 Rent payment due Oct 1, paid Oct 14 by `paidBy`. */
  async function addPayment(userId: string, hid: string, paidBy: string | null) {
    const bill = await addBill(userId, hid);
    const [{ id }] = await rows<{ id: string }>(
      `insert into payments (household_id, bill_id, due_date, paid_on, amount_cents, paid_by)
       values ($1, $2, '2026-10-01', '2026-10-14', 100000, $3) returning id`, [hid, bill, paidBy]);
    return id;
  }

  const edits = async (hid: string) => {
    await as(null);
    return rows<{ actor: string; message: string }>(
      `select actor, message from activity_log where household_id = $1 and message like '%edited%'`, [hid]);
  };

  it('logs every changed field under the partner who edited, even on the other partner\'s payment', async () => {
    const h = await household('Alex', 'Sam');
    const [alex, sam] = h.ids;
    const id = await addPayment(alex, h.hid, alex);

    await as(sam);
    const res = await db.query(`update payments set amount_cents = 125000, paid_on = '2026-10-02', paid_by = $1 where id = $2`, [sam, id]);
    expect(res.affectedRows).toBe(1);
    expect(await edits(h.hid)).toEqual([{
      actor: sam,
      message: 'Sam edited Rent (due Oct 1): $1,000.00 → $1,250.00, paid on Oct 14 → Oct 2, paid from Alex → Sam',
    }]);
  });

  it('lists only the field that changed', async () => {
    const h = await household('Alex', 'Sam');
    const id = await addPayment(h.ids[0], h.hid, h.ids[0]);

    await as(h.ids[0]);
    await db.query(`update payments set paid_on = '2026-10-02' where id = $1`, [id]);
    expect((await edits(h.hid)).map((e) => e.message)).toEqual(['Alex edited Rent (due Oct 1): paid on Oct 14 → Oct 2']);
  });

  it('logs nothing when a save changes nothing', async () => {
    const h = await household('Alex', 'Sam');
    const id = await addPayment(h.ids[0], h.hid, null);

    await as(h.ids[0]);
    const res = await db.query(`update payments set amount_cents = 100000, paid_on = '2026-10-14', paid_by = null where id = $1`, [id]);
    expect(res.affectedRows).toBe(1);
    expect(await edits(h.hid)).toEqual([]);
  });

  it('logs a change to and from the shared account', async () => {
    const h = await household('Alex', 'Sam');
    const id = await addPayment(h.ids[0], h.hid, h.ids[0]);

    await as(h.ids[0]);
    await db.query('update payments set paid_by = null where id = $1', [id]);
    await as(h.ids[0]);
    await db.query('update payments set paid_by = $1 where id = $2', [h.ids[0], id]);
    expect((await edits(h.hid)).map((e) => e.message).sort()).toEqual([
      'Alex edited Rent (due Oct 1): paid from Alex → Shared account',
      'Alex edited Rent (due Oct 1): paid from Shared account → Alex',
    ]);
  });

  it('does not log an edit when deleting the payer\'s account clears paid_by', async () => {
    const h = await household('Alex', 'Sam');
    const [alex, sam] = h.ids;
    const id = await addPayment(alex, h.hid, sam);

    await as(null);
    await db.query('delete from auth.users where id = $1', [sam]);
    expect(await count('payments where id = $1 and paid_by is null', [id])).toBe(1);
    expect(await edits(h.hid)).toEqual([]);
  });

  it('gives an outsider no way to change a payment or add to the log', async () => {
    const h = await household('Alex', 'Sam');
    const outsider = await household('Kim');
    const id = await addPayment(h.ids[0], h.hid, null);

    await as(outsider.ids[0]);
    expect((await db.query('update payments set amount_cents = 1 where id = $1', [id])).affectedRows).toBe(0);
    expect(await count('payments where id = $1 and amount_cents = 100000', [id])).toBe(1);
    expect(await edits(h.hid)).toEqual([]);
  });

  it('still logs marking and unmarking', async () => {
    const h = await household('Alex', 'Sam');
    const id = await addPayment(h.ids[0], h.hid, null);

    await as(h.ids[1]);
    await db.query('delete from payments where id = $1', [id]);
    await as(null);
    const log = (await rows<{ message: string }>('select message from activity_log where household_id = $1', [h.hid])).map((r) => r.message);
    expect(log).toContain('Alex marked Rent (due 2026-10-01) paid: $1,000.00 by shared account');
    expect(log).toContain('Sam unmarked Rent (due 2026-10-01) as paid');
  });
});

describe('account-balance.sql', () => {
  /** Save a balance the way saveBalance's upsert does: entered_at is never sent. */
  const save = async (hid: string, memberId: string, cents: number) => (await rows<{ entered_at: string }>(
    `insert into account_balances (household_id, member_id, week_start, amount_cents, spare_cents) values ($1, $2, '2026-11-01', $3, 0)
     on conflict (member_id, week_start) do update set amount_cents = excluded.amount_cents, spare_cents = excluded.spare_cents
     returning entered_at::text`, [hid, memberId, cents]))[0].entered_at;

  const logged = async (hid: string) => {
    await as(null);
    return (await rows<{ message: string }>(
      `select message from activity_log where household_id = $1 and message like '%bill account balance%' order by id`, [hid])).map((r) => r.message);
  };

  it('lets a partner write only their own balance, and both read it', async () => {
    const h = await household('Alex', 'Sam');
    const [alex, sam] = h.ids;
    const outsider = await household('Kim');

    await as(alex);
    await save(h.hid, alex, 35000);
    await expect(save(h.hid, sam, 1)).rejects.toThrow(/row-level security/);

    await as(sam);
    expect(await rows('select amount_cents from account_balances where member_id = $1', [alex])).toHaveLength(1);
    expect((await db.query('update account_balances set amount_cents = 1 where member_id = $1', [alex])).affectedRows).toBe(0);
    await as(outsider.ids[0]);
    expect(await rows('select 1 from account_balances where member_id = $1', [alex])).toEqual([]);
    expect(await count('account_balances where member_id = $1 and amount_cents = 35000', [alex])).toBe(1);
  });

  it('keeps entered_at when the same week is saved again', async () => {
    const h = await household('Alex');
    await as(h.ids[0]);
    const first = await save(h.hid, h.ids[0], 35000);
    expect(await save(h.hid, h.ids[0], 34000)).toBe(first);
    expect(await count('account_balances where member_id = $1', [h.ids[0]])).toBe(1);
  });

  it('rejects a negative amount', async () => {
    const h = await household('Alex');
    await as(h.ids[0]);
    await expect(save(h.hid, h.ids[0], -1)).rejects.toThrow(/check constraint/);
  });

  it('cannot be deleted by a partner', async () => {
    const h = await household('Alex', 'Sam');
    await as(h.ids[0]);
    await save(h.hid, h.ids[0], 35000);
    await as(h.ids[1]);
    expect((await db.query('delete from account_balances where member_id = $1', [h.ids[0]])).affectedRows).toBe(0);
    expect(await count('account_balances where member_id = $1', [h.ids[0]])).toBe(1);
  });

  it('logs entering and changing a balance, but not saving the same number', async () => {
    const h = await household('Alex');
    await as(h.ids[0]);
    await save(h.hid, h.ids[0], 35000);
    await save(h.hid, h.ids[0], 35000);
    await save(h.hid, h.ids[0], 34000);
    expect(await logged(h.hid)).toEqual([
      'Alex entered the bill account balance: $350.00',
      'Alex changed the bill account balance: $350.00 → $340.00',
    ]);
  });

  it('removes a partner\'s balances along with them', async () => {
    const h = await household('Alex', 'Sam');
    await as(h.ids[1]);
    await save(h.hid, h.ids[1], 35000);
    await as(null);
    await db.query('delete from members where user_id = $1', [h.ids[1]]);
    expect(await count('account_balances where member_id = $1', [h.ids[1]])).toBe(0);
  });
});

describe('deposit credit history', () => {
  it('records exactly one editable deposit and rejects a stale or reused confirmation', async () => {
    const home = await household('Alex', 'Sam');
    const bill = await addBill(home.ids[0], home.hid);
    const id = crypto.randomUUID();
    const sql = `select public.confirm_deposit_credit($1, $2, $3, (now() at time zone 'UTC')::date,
      '2026-01-07', $4, $5, $6, '2026-01-04') as result`;
    await expect(db.query(sql, [home.ids[0], home.hid, '0', id, 5375, true])).rejects.toThrow(/permission denied/);

    const asWorker = async () => {
      await as(null);
      await db.exec('set role service_role');
    };
    const revision = async () => (await rows<{ revision: string }>(
      "select public.deposit_credit_inputs($1)->>'revision' as revision", [home.ids[0]]))[0].revision;
    const confirm = (version: string, id: string, amount = 5375, valid = true) => rows(sql,
      [home.ids[0], home.hid, version, id, amount, valid]);
    await asWorker();
    const old = await revision();
    await as(home.ids[0]);
    await db.query('update bills set amount_cents = 9000 where id = $1', [bill]);
    await asWorker();
    expect(await confirm(old, id)).toEqual([{ result: 'stale' }]);
    const afterBillEdit = await revision();
    await as(home.ids[0]);
    await db.query(`insert into account_balances (household_id, member_id, week_start, amount_cents, spare_cents)
      values ($1, $2, '2026-01-04', 5000, 3000)`, [home.hid, home.ids[0]]);
    await asWorker();
    expect(await confirm(afterBillEdit, id)).toEqual([{ result: 'stale' }]);
    const current = await revision();
    expect(await confirm(current, id)).toEqual([{ result: 'saved' }]);
    expect(await confirm(current, id, 5375, false)).toEqual([{ result: 'saved' }]);
    expect(await confirm(current, id, 5400)).toEqual([{ result: 'invalid' }]);
    expect(await confirm(current, crypto.randomUUID())).toEqual([{ result: 'stale' }]);
    await as(home.ids[0]);
    expect(await rows('select member_id, amount_cents::int, week_start::text from contributions'))
      .toEqual([{ member_id: home.ids[0], amount_cents: 5375, week_start: '2026-01-04' }]);
  });

  it('captures old calculation inputs without exposing them to clients', async () => {
    const home = await household('Alex', 'Sam');
    const id = await addBill(home.ids[0], home.hid);
    await db.query('update bills set amount_cents = 200000 where id = $1', [id]);
    await expect(db.query('select public.deposit_credit_inputs($1)', [home.ids[0]])).rejects.toThrow(/permission denied/);
    await expect(db.query('select * from deposit_credit_private.changes')).rejects.toThrow(/permission denied/);

    await as(null);
    await db.exec('set role service_role');
    const [{ data }] = await rows<{ data: { bills: unknown[]; changes: unknown[]; revision: string; members: { user_id: string; created_at: string }[] } }>(
      'select public.deposit_credit_inputs($1) as data', [home.ids[0]]);
    expect(data.bills).toContainEqual(expect.objectContaining({ id, amount_cents: 200000 }));
    expect(data.changes).toContainEqual(expect.objectContaining({
      source: 'bills', row_id: id, before_row: expect.objectContaining({ id, amount_cents: 100000 }),
    }));
    expect(JSON.stringify(data)).not.toContain('invite_code');
    await as(null);
    await db.query(`update deposit_credit_private.changes set changed_at = '2026-01-05T00:00:00Z'
      where household_id = $1 and source = 'bills'`, [home.hid]);
    await db.exec('set role service_role');
    const payload = [{ member_id: home.ids[0],
      member_created_at: data.members.find((member) => member.user_id === home.ids[0])!.created_at, period_start: '2026-01-04',
      next_period_start: '2026-01-11', carry_cents: 3000 }];
    const claims = [{ bill_id: id, due_date: '2026-01-04' }];
    const save = (revision: string, periods = payload) => rows<{ saved: boolean }>(
      'select public.save_deposit_credit($1, $2, $3, $4, $5, $6) as saved',
      [home.ids[0], home.hid, revision, '2026-01-11', JSON.stringify(periods), JSON.stringify(claims)],
    );
    expect(await save('0')).toEqual([{ saved: false }]);
    expect(await save(data.revision)).toEqual([{ saved: true }]);
    expect(await save(data.revision, [{ ...payload[0], carry_cents: 9999 }])).toEqual([{ saved: true }]);
    const [{ saved }] = await rows<{ saved: unknown[] }>(
      "select public.deposit_credit_inputs($1)->'settlements' as saved", [home.ids[0]]);
    expect(saved).toEqual(payload);
    await as(null);
  });
});
