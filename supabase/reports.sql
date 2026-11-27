-- Apply after schema.sql. Reports use existing household RLS and recorded data.
create index if not exists reports_payments_paid_idx on public.payments (household_id, paid_on desc, id desc);
create index if not exists reports_payments_due_idx on public.payments (household_id, due_date);
create index if not exists reports_contributions_week_idx on public.contributions (household_id, week_start);
create index if not exists reports_paychecks_paid_idx on public.paychecks (household_id, member_id, paid_on desc);

create or replace function public.report_summary(
  p_household uuid,
  p_from date, p_to date,
  p_previous_from date, p_previous_to date,
  p_month_from date, p_month_to date, p_as_of date
) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with scope as (
    select p_household as id
    where p_household = public.my_household()
      and p_to <= p_as_of
      and p_to - p_from between 0 and 365
      and p_previous_to - p_previous_from between 0 and 365
      and p_month_to - p_month_from between 0 and 30
  ), period_payments as (
    select p.*, b.name, b.category, b.owner_id
    from scope s
    join public.payments p on p.household_id = s.id
    join public.bills b on b.id = p.bill_id and b.household_id = s.id
    where p.paid_on between p_from and p_to
  ), month_payments as (
    select p.paid_by, p.amount_cents, b.owner_id
    from scope s
    join public.payments p on p.household_id = s.id
    join public.bills b on b.id = p.bill_id and b.household_id = s.id
    where p.paid_on between p_month_from and p_month_to
  ), bill_totals as (
    select bill_id as id, name, category, sum(amount_cents) as cents, count(*) as count
    from period_payments group by bill_id, name, category
  ), months as (
    select date_trunc('month', paid_on::timestamp)::date as month, sum(amount_cents) as cents
    from period_payments group by 1
  ), period_direct as (
    select paid_by as "memberId", sum(amount_cents) as cents
    from period_payments where owner_id is null and paid_by is not null group by paid_by
  ), monthly_contributions as (
    select date_trunc('month', entry_date::timestamp)::date as month,
      member_id as "memberId", sum(amount_cents) as cents
    from (
      select paid_on as entry_date, paid_by as member_id, amount_cents
      from period_payments where owner_id is null and paid_by is not null
      union all
      select c.week_start, c.member_id, c.amount_cents from scope s
      join public.contributions c on c.household_id = s.id
      where c.week_start between p_from and p_to
    ) entries
    group by 1, 2
  ), month_direct as (
    select paid_by as "memberId", sum(amount_cents) as cents
    from month_payments where owner_id is null and paid_by is not null group by paid_by
  ), month_personal as (
    select paid_by as "memberId", sum(amount_cents) as cents
    from month_payments where owner_id is not null and paid_by is not null group by paid_by
  ), period_deposits as (
    select c.member_id, sum(c.amount_cents) as amount_cents from scope s
    join public.contributions c on c.household_id = s.id
    where c.week_start between p_from and p_to group by c.member_id
  ), month_deposits as (
    select c.member_id, sum(c.amount_cents) as amount_cents from scope s
    join public.contributions c on c.household_id = s.id
    where c.week_start between p_month_from and p_month_to group by c.member_id
  ), paid_occurrences as (
    select p.bill_id, p.due_date from scope s
    join public.payments p on p.household_id = s.id
    where p.due_date between p_from and p_to and p.paid_on <= p_as_of
  ), report_bills as (
    select b.id, b.amount_cents, b.start_date, b.recurrence, b.active, b.autopay
    from scope s join public.bills b on b.household_id = s.id
    where b.active and not b.autopay and b.start_date <= p_to
  ), checks as (
    select p.member_id, p.paid_on, p.amount_cents from scope s
    join public.paychecks p on p.household_id = s.id
    where p.paid_on between p_month_from and p_month_to
  ), paycheck_anchors as (
    select m.user_id as "memberId", p.paid_on as date from scope s
    join public.members m on m.household_id = s.id
    cross join lateral (
      select paid_on from public.paychecks p
      where p.household_id = s.id and p.member_id = m.user_id and paid_on <= p_month_to
      order by paid_on desc limit 1
    ) p
  )
  select jsonb_build_object(
    'billTotals', coalesce((select jsonb_agg(bt order by bt.name, bt.id) from bill_totals bt), '[]'::jsonb),
    'previousPaidCents', coalesce((select sum(p.amount_cents) from scope s
      join public.payments p on p.household_id = s.id
      join public.bills b on b.id = p.bill_id and b.household_id = s.id
      where p.paid_on between p_previous_from and p_previous_to), 0),
    'paidOccurrences', coalesce((select jsonb_agg(po) from paid_occurrences po), '[]'::jsonb),
    'bills', coalesce((select jsonb_agg(b) from report_bills b), '[]'::jsonb),
    'months', coalesce((select jsonb_agg(m) from months m), '[]'::jsonb),
    'monthlyContributions', coalesce((select jsonb_agg(c) from monthly_contributions c), '[]'::jsonb),
    'periodDirect', coalesce((select jsonb_agg(p) from period_direct p), '[]'::jsonb),
    'monthDirect', coalesce((select jsonb_agg(p) from month_direct p), '[]'::jsonb),
    'monthPersonal', coalesce((select jsonb_agg(p) from month_personal p), '[]'::jsonb),
    'periodDeposits', coalesce((select jsonb_agg(p) from period_deposits p), '[]'::jsonb),
    'monthDeposits', coalesce((select jsonb_agg(p) from month_deposits p), '[]'::jsonb),
    'checks', coalesce((select jsonb_agg(c) from checks c), '[]'::jsonb),
    'paycheckAnchors', coalesce((select jsonb_agg(p) from paycheck_anchors p), '[]'::jsonb)
  ) from scope;
$$;

create or replace function public.report_payments(
  p_household uuid, p_from date, p_to date, p_category text, p_bill uuid,
  p_cursor_date date, p_cursor_id uuid
) returns table (
  id uuid, "billId" uuid, "billName" text, category text,
  "paidOn" date, "paidBy" uuid, cents bigint
)
language sql stable security invoker set search_path = '' as $$
  select p.id, b.id, b.name, b.category, p.paid_on, p.paid_by, p.amount_cents
  from public.payments p
  join public.bills b on b.id = p.bill_id and b.household_id = p_household
  where p.household_id = p_household and p_household = public.my_household()
    and p_to - p_from between 0 and 365
    and p.paid_on between p_from and p_to
    and (p_category is null or lower(b.category) = lower(p_category))
    and (p_bill is null or p.bill_id = p_bill)
    and (p_cursor_date is null or (p.paid_on, p.id) < (p_cursor_date, p_cursor_id))
  order by p.paid_on desc, p.id desc
  limit 51;
$$;

revoke execute on function public.report_summary(uuid, date, date, date, date, date, date, date) from public, anon;
revoke execute on function public.report_payments(uuid, date, date, text, uuid, date, uuid) from public, anon;
grant execute on function public.report_summary(uuid, date, date, date, date, date, date, date) to authenticated;
grant execute on function public.report_payments(uuid, date, date, text, uuid, date, uuid) to authenticated;
