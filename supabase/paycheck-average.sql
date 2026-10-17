-- =====================================================================
-- Bill Tracker — how a "log each paycheck" partner's average is worked out
-- Run once after schema.sql (safe to re-run).
--   auto         = latest month's worth of paychecks added up
--   per_paycheck = average of those paychecks × paychecks per year ÷ 12
-- =====================================================================

alter table public.members add column if not exists paycheck_average text not null default 'auto'
  check (paycheck_average in ('auto', 'per_paycheck'));

grant update (paycheck_average) on public.members to authenticated;
