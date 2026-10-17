// Runs the real Supabase SQL in an in-memory Postgres (PGlite) and checks who can do what.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { beforeAll, describe, expect, it } from 'vitest';
import schemaSql from '../supabase/schema.sql?raw';
import leaveSql from '../supabase/leave.sql?raw';
import adminSql from '../supabase/admin.sql?raw';
import paycheckAverageSql from '../supabase/paycheck-average.sql?raw';

// The bits of Supabase the schema relies on: API roles, auth.users, auth.uid(), default grants.
const SUPABASE_STUB = `
  create role anon nologin;
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
  for (const sql of [schemaSql, leaveSql, adminSql, paycheckAverageSql, paycheckAverageSql]) await db.exec(sql);
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
    expect(await rows('select paycheck_average from members where user_id = $1', [h.ids[1]])).toEqual([{ paycheck_average: 'auto' }]);
    await db.query(`update members set paycheck_average = 'per_paycheck' where user_id = $1`, [h.ids[1]]);
    expect(await rows('select paycheck_average from members where user_id = $1', [h.ids[1]])).toEqual([{ paycheck_average: 'per_paycheck' }]);
    await expect(db.query(`update members set paycheck_average = 'weekly' where user_id = $1`, [h.ids[1]])).rejects.toThrow(/check constraint/);
    await db.query(`update members set paycheck_average = 'per_paycheck', display_name = 'Sammy' where user_id = $1`, [h.ids[1]]); // unchanged: no log
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
