-- =====================================================================
-- Bill Tracker — how a "log each paycheck" partner's average is worked out
-- Run once after schema.sql (safe to re-run).
--   auto         = latest month's worth of paychecks added up
--   per_paycheck = average of those paychecks × paychecks per year ÷ 12
-- =====================================================================

alter table public.members add column if not exists paycheck_average text not null default 'auto'
  check (paycheck_average in ('auto', 'per_paycheck'));

grant update (paycheck_average) on public.members to authenticated;

-- It changes the bill split, so log it like an income mode change.
create or replace function public.log_paycheck_average()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into activity_log (household_id, actor, message)
  values (new.household_id, auth.uid(),
          new.display_name || '''s paycheck average is now ' ||
          case when new.paycheck_average = 'auto' then 'automatic' else 'by paycheck' end);
  return new;
end $$;

drop trigger if exists log_paycheck_average on public.members;
create trigger log_paycheck_average after update of paycheck_average on public.members
  for each row when (new.paycheck_average is distinct from old.paycheck_average)
  execute function public.log_paycheck_average();
