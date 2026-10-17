-- =====================================================================
-- Bill Tracker — Supabase schema
-- Run this whole file once in Supabase: Dashboard → SQL Editor → New query.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- One household = the two of you.
create table public.households (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null default 'Our household',
  invite_code          text not null unique,
  weekly_mode          text not null default 'smoothed'
                         check (weekly_mode in ('smoothed', 'due')),
  income_window_months int  not null default 3
                         check (income_window_months between 1 and 12),
  created_at           timestamptz not null default now()
);

-- Each partner. user_id is the Supabase auth user.
create table public.members (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  household_id     uuid not null references public.households (id) on delete cascade,
  display_name     text not null,
  pay_amount_cents bigint not null default 0 check (pay_amount_cents >= 0),
  pay_frequency    text not null default 'biweekly'
                     check (pay_frequency in ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  income_mode      text not null default 'fixed'
                     check (income_mode in ('fixed', 'per_paycheck')),
  created_at       timestamptz not null default now()
);
create index on public.members (household_id);

-- Bills. owner_id NULL = shared (split by income). owner_id set = personal.
-- owner_id can only be changed through an approved request (see decide_request).
create table public.bills (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name         text not null,
  amount_cents bigint not null check (amount_cents >= 0),
  category     text not null default 'Other',
  recurrence   text not null default 'monthly'
                 check (recurrence in ('once', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly')),
  start_date   date not null,          -- first due date; repeats from here
  autopay      boolean not null default false,
  owner_id     uuid references public.members (user_id) on delete set null,
  active       boolean not null default true,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on public.bills (household_id);

-- A bill occurrence that was paid. paid_by NULL = paid from the shared account.
create table public.payments (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  bill_id      uuid not null references public.bills (id) on delete cascade,
  due_date     date not null,
  paid_on      date not null default current_date,
  amount_cents bigint not null check (amount_cents >= 0),
  paid_by      uuid references public.members (user_id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (bill_id, due_date)
);
create index on public.payments (household_id);

-- Weekly deposits into the shared bill account (smoothed mode).
create table public.contributions (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  member_id    uuid not null references public.members (user_id) on delete cascade,
  week_start   date not null,
  amount_cents bigint not null check (amount_cents >= 0),
  created_at   timestamptz not null default now()
);
create index on public.contributions (household_id);

-- Logged paychecks (only used when a member's income_mode = 'per_paycheck').
create table public.paychecks (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  member_id    uuid not null references public.members (user_id) on delete cascade,
  amount_cents bigint not null check (amount_cents >= 0),
  paid_on      date not null,
  created_at   timestamptz not null default now()
);
create index on public.paychecks (household_id);

-- Requests to make a bill personal (or shared again). Needs the other partner.
create table public.bill_requests (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  bill_id      uuid not null references public.bills (id) on delete cascade,
  kind         text not null check (kind in ('make_personal', 'make_shared')),
  owner_id     uuid references public.members (user_id) on delete cascade,
  requested_by uuid not null default auth.uid() references public.members (user_id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled')),
  decided_by   uuid references public.members (user_id) on delete set null,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  check ((kind = 'make_personal') = (owner_id is not null))
);
create index on public.bill_requests (household_id);
-- Only one open request per bill at a time.
create unique index bill_requests_one_pending on public.bill_requests (bill_id) where status = 'pending';

-- Who changed what.
create table public.activity_log (
  id           bigint generated always as identity primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  actor        uuid,
  message      text not null,
  created_at   timestamptz not null default now()
);
create index on public.activity_log (household_id, created_at desc);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- The household of the signed-in user (NULL if none yet).
create or replace function public.my_household()
returns uuid language sql stable security definer set search_path = public as $$
  select household_id from public.members where user_id = auth.uid()
$$;

create or replace function public.fmt_cents(c bigint)
returns text language sql immutable as $$
  select '$' || to_char(c / 100.0, 'FM999,999,990.00')
$$;

create or replace function public.member_name(uid uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select display_name from public.members where user_id = uid), 'Someone')
$$;

-- ---------------------------------------------------------------------
-- Household setup (create / join)
-- ---------------------------------------------------------------------

create or replace function public.create_household(p_household_name text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$  -- Supabase installs pgcrypto (gen_random_bytes) in the extensions schema
declare
  v_id   uuid;
  v_code text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if exists (select 1 from members where user_id = auth.uid()) then
    raise exception 'You already belong to a household';
  end if;

  loop
    v_code := upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 6));
    exit when not exists (select 1 from households where invite_code = v_code);
  end loop;

  insert into households (name, invite_code)
  values (coalesce(nullif(trim(p_household_name), ''), 'Our household'), v_code)
  returning id into v_id;

  insert into members (user_id, household_id, display_name)
  values (auth.uid(), v_id, trim(p_display_name));

  return v_id;
end $$;

create or replace function public.join_household(p_invite_code text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if exists (select 1 from members where user_id = auth.uid()) then
    raise exception 'You already belong to a household';
  end if;

  select id into v_id from households where invite_code = upper(trim(p_invite_code)) for update;
  if v_id is null then raise exception 'Invite code not found'; end if;
  if (select count(*) from members where household_id = v_id) >= 2 then
    raise exception 'This household already has two partners';
  end if;

  insert into members (user_id, household_id, display_name)
  values (auth.uid(), v_id, trim(p_display_name));

  insert into activity_log (household_id, actor, message)
  values (v_id, auth.uid(), trim(p_display_name) || ' joined the household');

  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Personal-bill approvals
-- ---------------------------------------------------------------------

-- The partner who did NOT make the request approves or declines it.
-- The requester can cancel their own request.
create or replace function public.decide_request(p_request_id uuid, p_decision text)
returns void language plpgsql security definer set search_path = public as $$
declare
  r      bill_requests%rowtype;
  v_bill text;
begin
  select * into r from bill_requests where id = p_request_id for update;
  if r.id is null or r.household_id is distinct from my_household() then
    raise exception 'Request not found';
  end if;
  if r.status <> 'pending' then raise exception 'This request was already handled'; end if;

  if p_decision = 'cancelled' then
    if r.requested_by <> auth.uid() then raise exception 'Only the requester can cancel'; end if;
  elsif p_decision in ('approved', 'declined') then
    if r.requested_by = auth.uid() then
      raise exception 'Your partner has to approve this, not you';
    end if;
  else
    raise exception 'Unknown decision %', p_decision;
  end if;

  update bill_requests
     set status = p_decision, decided_by = auth.uid(), decided_at = now()
   where id = r.id;

  select name into v_bill from bills where id = r.bill_id;

  if p_decision = 'approved' then
    -- Mark this transaction so the bills guard trigger lets owner_id change.
    perform set_config('app.approved_owner_change', 'on', true);
    update bills
       set owner_id = case when r.kind = 'make_personal' then r.owner_id else null end,
           updated_at = now()
     where id = r.bill_id;
    perform set_config('app.approved_owner_change', 'off', true);
  end if;

  insert into activity_log (household_id, actor, message)
  values (r.household_id, auth.uid(),
          member_name(auth.uid()) || ' ' || p_decision || ' the request to make ' || v_bill ||
          case when r.kind = 'make_personal'
               then ' personal (' || member_name(r.owner_id) || ')'
               else ' shared' end);
end $$;

-- ---------------------------------------------------------------------
-- Guards and activity logging
-- ---------------------------------------------------------------------

-- Bills: owner_id only changes via an approved request; new bills start shared.
create or replace function public.bills_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.owner_id is not null then
      raise exception 'New bills start shared. Request to make it personal afterwards.';
    end if;
  elsif tg_op = 'UPDATE' then
    if new.owner_id is distinct from old.owner_id
       and coalesce(current_setting('app.approved_owner_change', true), 'off') <> 'on' then
      raise exception 'Changing who owns a bill needs your partner''s approval';
    end if;
    if new.household_id <> old.household_id then
      raise exception 'Bills cannot move between households';
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;

create trigger bills_guard before insert or update on public.bills
for each row execute function public.bills_guard();

create or replace function public.log_bills()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  who     text := member_name(auth.uid());
  changes text[] := '{}';
begin
  if tg_op = 'INSERT' then
    insert into activity_log (household_id, actor, message)
    values (new.household_id, auth.uid(),
            who || ' added ' || new.name || ' (' || fmt_cents(new.amount_cents) || ', ' || new.recurrence || ')');
    return new;
  elsif tg_op = 'DELETE' then
    insert into activity_log (household_id, actor, message)
    values (old.household_id, auth.uid(), who || ' deleted ' || old.name);
    return old;
  end if;

  -- UPDATE: describe what changed (owner changes are logged by decide_request)
  if new.name <> old.name then changes := changes || ('name "' || old.name || '" → "' || new.name || '"'); end if;
  if new.amount_cents <> old.amount_cents then
    changes := changes || (fmt_cents(old.amount_cents) || ' → ' || fmt_cents(new.amount_cents));
  end if;
  if new.recurrence <> old.recurrence then changes := changes || (old.recurrence || ' → ' || new.recurrence); end if;
  if new.start_date <> old.start_date then changes := changes || ('due date ' || old.start_date || ' → ' || new.start_date); end if;
  if new.category <> old.category then changes := changes || ('category ' || old.category || ' → ' || new.category); end if;
  if new.autopay <> old.autopay then changes := changes || ('autopay ' || case when new.autopay then 'on' else 'off' end); end if;
  if new.active <> old.active then changes := changes || (case when new.active then 'reactivated' else 'paused' end); end if;

  if array_length(changes, 1) > 0 then
    insert into activity_log (household_id, actor, message)
    values (new.household_id, auth.uid(), who || ' edited ' || new.name || ': ' || array_to_string(changes, ', '));
  end if;
  return new;
end $$;

create trigger log_bills after insert or update or delete on public.bills
for each row execute function public.log_bills();

create or replace function public.log_payments()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_bill text;
begin
  if tg_op = 'INSERT' then
    select name into v_bill from bills where id = new.bill_id;
    insert into activity_log (household_id, actor, message)
    values (new.household_id, auth.uid(),
            member_name(auth.uid()) || ' marked ' || v_bill || ' (due ' || new.due_date || ') paid: ' ||
            fmt_cents(new.amount_cents) || ' by ' ||
            case when new.paid_by is null then 'shared account' else member_name(new.paid_by) end);
    return new;
  else
    select name into v_bill from bills where id = old.bill_id;
    insert into activity_log (household_id, actor, message)
    values (old.household_id, auth.uid(),
            member_name(auth.uid()) || ' unmarked ' || coalesce(v_bill, 'a bill') || ' (due ' || old.due_date || ') as paid');
    return old;
  end if;
end $$;

create trigger log_payments after insert or delete on public.payments
for each row execute function public.log_payments();

create or replace function public.log_members()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.pay_amount_cents <> old.pay_amount_cents or new.pay_frequency <> old.pay_frequency then
    insert into activity_log (household_id, actor, message)
    values (new.household_id, auth.uid(),
            member_name(auth.uid()) || ' updated ' || new.display_name || '''s pay: ' ||
            fmt_cents(old.pay_amount_cents) || ' ' || old.pay_frequency || ' → ' ||
            fmt_cents(new.pay_amount_cents) || ' ' || new.pay_frequency);
  end if;
  if new.income_mode <> old.income_mode then
    insert into activity_log (household_id, actor, message)
    values (new.household_id, auth.uid(),
            new.display_name || '''s income is now ' ||
            case when new.income_mode = 'fixed' then 'fixed' else 'logged per paycheck' end);
  end if;
  if new.household_id <> old.household_id or new.user_id <> old.user_id then
    raise exception 'Cannot move members';
  end if;
  return new;
end $$;

create trigger log_members before update on public.members
for each row execute function public.log_members();

create or replace function public.log_contributions()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into activity_log (household_id, actor, message)
    values (new.household_id, auth.uid(),
            member_name(new.member_id) || ' put ' || fmt_cents(new.amount_cents) ||
            ' into the bill account (week of ' || new.week_start || ')');
    return new;
  end if;
  insert into activity_log (household_id, actor, message)
  values (old.household_id, auth.uid(),
          member_name(auth.uid()) || ' removed ' || member_name(old.member_id) || '''s ' ||
          fmt_cents(old.amount_cents) || ' deposit (week of ' || old.week_start || ')');
  return old;
end $$;

create trigger log_contributions after insert or delete on public.contributions
for each row execute function public.log_contributions();

create or replace function public.log_paychecks()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into activity_log (household_id, actor, message)
    values (new.household_id, auth.uid(),
            member_name(auth.uid()) || ' logged a ' || fmt_cents(new.amount_cents) ||
            ' paycheck for ' || member_name(new.member_id) || ' (' || new.paid_on || ')');
    return new;
  end if;
  insert into activity_log (household_id, actor, message)
  values (old.household_id, auth.uid(),
          member_name(auth.uid()) || ' removed a ' || fmt_cents(old.amount_cents) ||
          ' paycheck for ' || member_name(old.member_id) || ' (' || old.paid_on || ')');
  return old;
end $$;

create trigger log_paychecks after insert or delete on public.paychecks
for each row execute function public.log_paychecks();

create or replace function public.log_requests()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_bill text;
begin
  select name into v_bill from bills where id = new.bill_id;
  insert into activity_log (household_id, actor, message)
  values (new.household_id, auth.uid(),
          member_name(new.requested_by) || ' asked to make ' || v_bill ||
          case when new.kind = 'make_personal'
               then ' personal (' || member_name(new.owner_id) || ' pays all of it)'
               else ' shared again' end);
  return new;
end $$;

create trigger log_requests after insert on public.bill_requests
for each row execute function public.log_requests();

-- ---------------------------------------------------------------------
-- Row Level Security: you only see and change your own household
-- ---------------------------------------------------------------------

alter table public.households    enable row level security;
alter table public.members       enable row level security;
alter table public.bills         enable row level security;
alter table public.payments      enable row level security;
alter table public.contributions enable row level security;
alter table public.paychecks     enable row level security;
alter table public.bill_requests enable row level security;
alter table public.activity_log  enable row level security;

create policy "read own household" on public.households
  for select using (id = public.my_household());
create policy "update own household" on public.households
  for update using (id = public.my_household()) with check (id = public.my_household());

create policy "read household members" on public.members
  for select using (household_id = public.my_household());
-- Both partners can edit either partner's income (both phones can edit everything).
create policy "update household members" on public.members
  for update using (household_id = public.my_household()) with check (household_id = public.my_household());

do $$
declare t text;
begin
  foreach t in array array['bills', 'payments', 'paychecks'] loop
    execute format('create policy "household rows" on public.%I for all
                    using (household_id = public.my_household())
                    with check (household_id = public.my_household())', t);
  end loop;
end $$;

-- Deposits: both partners can see them, but you can only record or remove your own.
-- No update policy, so a deposit can't be reassigned to the other partner.
create policy "read deposits" on public.contributions
  for select using (household_id = public.my_household());
create policy "add own deposits" on public.contributions
  for insert with check (household_id = public.my_household() and member_id = auth.uid());
create policy "remove own deposits" on public.contributions
  for delete using (household_id = public.my_household() and member_id = auth.uid());

create policy "read requests" on public.bill_requests
  for select using (household_id = public.my_household());
create policy "create requests" on public.bill_requests
  for insert with check (
    household_id = public.my_household()
    and requested_by = auth.uid()
    and status = 'pending'
    and exists (select 1 from public.bills b where b.id = bill_id and b.household_id = public.my_household())
    and (owner_id is null or exists (
          select 1 from public.members m where m.user_id = owner_id and m.household_id = public.my_household()))
  );
-- Requests are decided only through decide_request(), so no update policy.

create policy "read activity" on public.activity_log
  for select using (household_id = public.my_household());

-- Column limits: the invite code and household id are not client-editable.
revoke update on public.households from authenticated;
grant  update (name, weekly_mode, income_window_months) on public.households to authenticated;
revoke update on public.members from authenticated;
grant  update (display_name, pay_amount_cents, pay_frequency, income_mode) on public.members to authenticated;

grant execute on function public.create_household(text, text) to authenticated;
grant execute on function public.join_household(text, text)   to authenticated;
grant execute on function public.decide_request(uuid, text)   to authenticated;

-- ---------------------------------------------------------------------
-- Realtime: push changes to both phones
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table
  public.households, public.members, public.bills, public.payments,
  public.contributions, public.paychecks, public.bill_requests, public.activity_log;
