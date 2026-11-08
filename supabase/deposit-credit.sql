-- Run after the existing schema, income, split, and pay-schedule SQL.
begin;
set local lock_timeout = '5s';

create schema if not exists deposit_credit_private;
revoke all on schema deposit_credit_private from public, anon, authenticated, service_role;

create table if not exists deposit_credit_private.rollout (
  singleton boolean primary key default true check (singleton),
  started_at timestamptz not null default clock_timestamp()
);
insert into deposit_credit_private.rollout (singleton) values (true) on conflict do nothing;

create table if not exists deposit_credit_private.changes (
  id bigint generated always as identity primary key,
  household_id uuid not null,
  changed_at timestamptz not null,
  transaction_id xid8 not null,
  source text not null,
  row_id uuid not null,
  before_row jsonb
);
create index if not exists deposit_credit_changes_household on deposit_credit_private.changes (household_id, id);
create index if not exists deposit_credit_changes_transaction
  on deposit_credit_private.changes (household_id, transaction_id);

create or replace function deposit_credit_private.append_change(home uuid, source_name text, row_id uuid, before_row jsonb)
returns void language sql set search_path = '' as $$
  insert into deposit_credit_private.changes
    (household_id, source, row_id, before_row, transaction_id, changed_at)
  values (home, source_name, row_id, before_row, pg_current_xact_id(), coalesce(
    (select changed_at from deposit_credit_private.changes
      where household_id = home and transaction_id = pg_current_xact_id() limit 1),
    clock_timestamp()
  ));
$$;

create table if not exists deposit_credit_private.settlements (
  household_id uuid not null,
  member_id uuid not null,
  member_created_at timestamptz not null,
  period_start date not null,
  next_period_start date not null check (next_period_start > period_start),
  carry_cents bigint not null check (carry_cents >= 0),
  primary key (household_id, member_id, member_created_at, period_start)
);

-- Claims outlive membership so re-entering a payment cannot spend its credit again.
create table if not exists deposit_credit_private.claims (
  household_id uuid not null,
  bill_id uuid not null,
  due_date date not null,
  primary key (household_id, bill_id, due_date)
);
create table if not exists deposit_credit_private.checkpoints (
  household_id uuid primary key,
  watermark date not null,
  revision bigint not null
);

create table if not exists deposit_credit_private.confirmations (
  household_id uuid not null,
  member_id uuid not null,
  confirmation_id uuid not null,
  period_start date not null,
  amount_cents bigint not null,
  primary key (household_id, member_id, confirmation_id)
);

create or replace function deposit_credit_private.revision(home uuid)
returns bigint language sql set search_path = '' as $$
  select greatest(
    coalesce((select max(id) from deposit_credit_private.changes where household_id = home), 0),
    coalesce((select revision from deposit_credit_private.checkpoints where household_id = home), 0)
  );
$$;

create or replace function deposit_credit_private.inputs(source text, row_value jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_object_agg(key, value)
  from jsonb_each(row_value)
  where key = any(case source
    when 'households' then array['id', 'weekly_mode', 'split_member', 'split_percent']
    when 'members' then array['user_id', 'household_id', 'created_at', 'pay_amount_cents',
      'pay_frequency', 'income_mode', 'paycheck_average', 'payday']
    when 'bills' then array['id', 'household_id', 'owner_id', 'amount_cents', 'recurrence',
      'start_date', 'autopay', 'active', 'name']
    when 'payments' then array['id', 'household_id', 'bill_id', 'due_date', 'paid_on',
      'paid_by', 'amount_cents']
    when 'contributions' then array['id', 'household_id', 'member_id', 'week_start', 'amount_cents']
    when 'paychecks' then array['id', 'household_id', 'member_id', 'paid_on', 'amount_cents']
  end);
$$;

create or replace function deposit_credit_private.record_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  before_row jsonb := deposit_credit_private.inputs(tg_table_name, to_jsonb(old));
  after_row jsonb := deposit_credit_private.inputs(tg_table_name, to_jsonb(new));
  id_key text := case when tg_table_name = 'members' then 'user_id' else 'id' end;
  household_key text := case when tg_table_name = 'households' then 'id' else 'household_id' end;
  old_home uuid := (before_row ->> household_key)::uuid;
  new_home uuid := (after_row ->> household_key)::uuid;
  old_id uuid := (before_row ->> id_key)::uuid;
  new_id uuid := (after_row ->> id_key)::uuid;
  home uuid;
begin
  if before_row is not distinct from after_row then return null; end if;
  -- Writers can overlap. Workers take the matching exclusive lock without
  -- waiting on app rows, so a writer holding a child row cannot deadlock them.
  for home in select distinct h from unnest(array[old_home, new_home]) as homes(h)
    where h is not null order by h
  loop
    perform pg_advisory_xact_lock_shared(hashtextextended(home::text, 8624));
  end loop;

  if tg_table_name = 'households' and tg_op = 'DELETE' then
    delete from deposit_credit_private.changes where household_id = old_home;
    delete from deposit_credit_private.settlements where household_id = old_home;
    delete from deposit_credit_private.claims where household_id = old_home;
    delete from deposit_credit_private.checkpoints where household_id = old_home;
    delete from deposit_credit_private.confirmations where household_id = old_home;
    return null;
  end if;

  if tg_table_name = 'members' and old_home is not null and old_home is distinct from new_home then
    delete from deposit_credit_private.confirmations where household_id = old_home and member_id = old_id;
  end if;

  if old_home is not null and exists (select 1 from public.households where id = old_home) then
    perform deposit_credit_private.append_change(old_home, tg_table_name, old_id, before_row);
  end if;
  if new_home is not null and (new_home, new_id) is distinct from (old_home, old_id) then
    perform deposit_credit_private.append_change(new_home, tg_table_name, new_id, null);
  end if;
  return null;
end;
$$;

do $$
declare source text;
begin
  foreach source in array array['households', 'members', 'bills', 'payments', 'contributions', 'paychecks']
  loop
    execute format('drop trigger if exists deposit_credit_history on public.%I', source);
    execute format('create trigger deposit_credit_history after insert or update or delete on public.%I
      for each row execute function deposit_credit_private.record_change()', source);
  end loop;
end;
$$;

-- Only the trusted worker can read historical inputs or write settlements.
create or replace function public.deposit_credit_inputs(caller uuid)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
  home uuid := (select household_id from public.members where user_id = caller);
begin
  if home is null then return null; end if;
  -- Freeze journal appends while reading the matching MVCC rows.
  perform pg_advisory_xact_lock(hashtextextended(home::text, 8624));
  if not exists (select 1 from public.members where user_id = caller and household_id = home) then
    return null;
  end if;
  return jsonb_build_object(
    'householdId', home,
    'asOf', clock_timestamp(),
    'rollout', (select started_at from deposit_credit_private.rollout),
    'revision', deposit_credit_private.revision(home)::text,
    'watermark', (select watermark from deposit_credit_private.checkpoints where household_id = home),
    'claims', (select jsonb_agg(to_jsonb(r) - 'household_id')
      from deposit_credit_private.claims r where household_id = home),
    'households', (select jsonb_agg(deposit_credit_private.inputs('households', to_jsonb(r))) from public.households r where id = home),
    'members', (select jsonb_agg(deposit_credit_private.inputs('members', to_jsonb(r))) from public.members r where household_id = home),
    'bills', (select jsonb_agg(deposit_credit_private.inputs('bills', to_jsonb(r))) from public.bills r where household_id = home),
    'payments', (select jsonb_agg(deposit_credit_private.inputs('payments', to_jsonb(r))) from public.payments r where household_id = home),
    'contributions', (select jsonb_agg(deposit_credit_private.inputs('contributions', to_jsonb(r))) from public.contributions r where household_id = home),
    'paychecks', (select jsonb_agg(deposit_credit_private.inputs('paychecks', to_jsonb(r))) from public.paychecks r where household_id = home),
    'changes', (select jsonb_agg(to_jsonb(r) - 'household_id' - 'id' - 'transaction_id' order by id desc)
      from deposit_credit_private.changes r where household_id = home),
    'settlements', (select jsonb_agg(to_jsonb(r) - 'household_id')
      from (select distinct on (member_id, member_created_at) *
        from deposit_credit_private.settlements where household_id = home
        order by member_id, member_created_at, period_start desc) r)
  );
end;
$$;

drop function if exists public.save_deposit_credit(uuid, uuid, jsonb);
create or replace function public.save_deposit_credit(
  caller uuid, home uuid, expected_revision bigint, prune_before date, periods jsonb, claims jsonb
)
returns boolean language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
begin
  -- Never wait for an app row while holding the exclusive journal lock.
  perform pg_advisory_xact_lock(hashtextextended(home::text, 8624));
  if not exists (select 1 from public.members where user_id = caller and household_id = home) then
    raise exception 'Not allowed';
  end if;
  if expected_revision <> deposit_credit_private.revision(home) then return false; end if;
  if prune_before > (clock_timestamp() at time zone 'UTC')::date then
    raise exception 'Cannot checkpoint a future date';
  end if;

  insert into deposit_credit_private.settlements
    (household_id, member_id, member_created_at, period_start, next_period_start, carry_cents)
  select home, p.member_id, p.member_created_at, p.period_start, p.next_period_start, p.carry_cents
  from jsonb_to_recordset(periods) p(member_id uuid, member_created_at timestamptz,
    period_start date, next_period_start date, carry_cents bigint)
  join public.members m on m.user_id = p.member_id and m.household_id = home and m.created_at = p.member_created_at
  where p.next_period_start <= (clock_timestamp() at time zone 'UTC')::date
  on conflict do nothing;

  insert into deposit_credit_private.claims (household_id, bill_id, due_date)
  select home, c.bill_id, c.due_date
  from jsonb_to_recordset(claims) c(bill_id uuid, due_date date)
  on conflict do nothing;

  -- Retain a departed member's last boundary only until their missed closed
  -- periods have been replayed; the anonymous occurrence claims remain.
  delete from deposit_credit_private.settlements s
  where s.household_id = home and not exists (
    select 1 from public.members m
    where m.household_id = home and m.user_id = s.member_id and m.created_at = s.member_created_at
  );

  -- Current rows are the baseline. Undo only changes at or after the earliest
  -- boundary still needed by any member to reconstruct that boundary.
  insert into deposit_credit_private.checkpoints (household_id, watermark, revision)
  values (home, prune_before, expected_revision)
  on conflict (household_id) do update set
    watermark = greatest(deposit_credit_private.checkpoints.watermark, excluded.watermark),
    revision = excluded.revision;
  delete from deposit_credit_private.changes
  where household_id = home and changed_at < (prune_before::timestamp at time zone 'UTC');
  return true;
end;
$$;

create or replace function public.confirm_deposit_credit(
  caller uuid, home uuid, expected_revision bigint, quote_date date,
  quoted_period date, confirmation uuid, amount bigint, quote_valid boolean
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  receipt deposit_credit_private.confirmations%rowtype;
begin
  if amount is null or amount <= 0 or quoted_period is null or confirmation is null then
    return 'invalid';
  end if;

  -- Take the contribution's FK locks first, without waiting while holding
  -- any other lock. App writers may already hold a row and need the journal.
  begin
    perform 1 from public.households where id = home for key share nowait;
    perform 1 from public.members where user_id = caller and household_id = home for key share nowait;
    if not found then return 'forbidden'; end if;
  exception when lock_not_available then
    return 'busy';
  end;
  if not pg_try_advisory_xact_lock(hashtextextended(home::text, 8624)) then
    return 'busy';
  end if;

  select * into receipt from deposit_credit_private.confirmations
  where household_id = home and member_id = caller and confirmation_id = confirmation;
  if found then
    return case when receipt.period_start = quoted_period and receipt.amount_cents = amount
      then 'saved' else 'invalid' end;
  end if;

  if quote_valid is distinct from true
    or quote_date is distinct from (clock_timestamp() at time zone 'UTC')::date
    or expected_revision is distinct from deposit_credit_private.revision(home)
  then
    return 'stale';
  end if;

  insert into public.contributions (household_id, member_id, week_start, amount_cents)
  values (home, caller, quoted_period - extract(dow from quoted_period)::integer, amount);
  insert into deposit_credit_private.confirmations (household_id, member_id, confirmation_id, period_start, amount_cents)
  values (home, caller, confirmation, quoted_period, amount);
  return 'saved';
end;
$$;

revoke all on function public.deposit_credit_inputs(uuid), public.save_deposit_credit(uuid, uuid, bigint, date, jsonb, jsonb),
  public.confirm_deposit_credit(uuid, uuid, bigint, date, date, uuid, bigint, boolean)
  from public, anon, authenticated;
grant execute on function public.deposit_credit_inputs(uuid), public.save_deposit_credit(uuid, uuid, bigint, date, jsonb, jsonb),
  public.confirm_deposit_credit(uuid, uuid, bigint, date, date, uuid, bigint, boolean)
  to service_role;
commit;
