-- =====================================================================
-- Bill Tracker — each partner edits only their own income
-- Run once after schema.sql (safe to re-run).
--   members:   you can update only your own row (pay, frequency, mode, name).
--   paychecks: both partners can see them; you can log or remove only your own.
-- Staff policies from admin.sql are separate and unaffected.
-- =====================================================================

drop policy if exists "update household members" on public.members;
drop policy if exists "update own member row" on public.members;
create policy "update own member row" on public.members
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Same shape as deposits: no update policy, so a paycheck can't be moved to the other partner.
drop policy if exists "household rows" on public.paychecks;
drop policy if exists "read paychecks" on public.paychecks;
drop policy if exists "add own paychecks" on public.paychecks;
drop policy if exists "remove own paychecks" on public.paychecks;
create policy "read paychecks" on public.paychecks
  for select using (household_id = public.my_household());
create policy "add own paychecks" on public.paychecks
  for insert with check (household_id = public.my_household() and member_id = auth.uid());
create policy "remove own paychecks" on public.paychecks
  for delete using (household_id = public.my_household() and member_id = auth.uid());
