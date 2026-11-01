-- =====================================================================
-- Bill Tracker — the real bank balance each partner types in (Pay as due)
-- Run once after schema.sql (safe to re-run), BEFORE deploying the app build
-- that reads it: load() fails without this table.
--   One row per partner per week_start (the payday week, the same key deposits use).
--   amount_cents: what the bank showed.
--   spare_cents:  that minus what deposits held for unpaid bills then. Frozen by the app,
--                 so paying bills later can't move the credit. Negative = account short.
--   You can read your partner's balances but change only your own. No delete: you edit one instead.
-- =====================================================================

create table if not exists public.account_balances (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  member_id    uuid not null references public.members (user_id) on delete cascade,
  week_start   date not null,
  amount_cents bigint not null check (amount_cents >= 0),
  spare_cents  bigint not null,
  entered_at   timestamptz not null default now(),
  unique (member_id, week_start)
);
create index if not exists account_balances_household_idx on public.account_balances (household_id);

alter table public.account_balances enable row level security;
grant select, insert, update on public.account_balances to authenticated;

drop policy if exists "read balances" on public.account_balances;
drop policy if exists "add own balances" on public.account_balances;
drop policy if exists "update own balances" on public.account_balances;
create policy "read balances" on public.account_balances
  for select using (household_id = public.my_household());
create policy "add own balances" on public.account_balances
  for insert with check (household_id = public.my_household() and member_id = auth.uid());
create policy "update own balances" on public.account_balances
  for update using (household_id = public.my_household() and member_id = auth.uid())
  with check (household_id = public.my_household() and member_id = auth.uid());

create or replace function public.log_account_balances()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into activity_log (household_id, actor, message)
    values (new.household_id, auth.uid(),
            member_name(new.member_id) || ' entered the bill account balance: ' || fmt_cents(new.amount_cents));
  elsif new.amount_cents <> old.amount_cents then
    insert into activity_log (household_id, actor, message)
    values (new.household_id, auth.uid(),
            member_name(new.member_id) || ' changed the bill account balance: ' ||
            fmt_cents(old.amount_cents) || ' → ' || fmt_cents(new.amount_cents));
  end if;
  return new;
end $$;

drop trigger if exists log_account_balances on public.account_balances;
create trigger log_account_balances after insert or update on public.account_balances
  for each row execute function public.log_account_balances();

do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'account_balances') then
    alter publication supabase_realtime add table public.account_balances;
  end if;
end $$;

notify pgrst, 'reload schema';
