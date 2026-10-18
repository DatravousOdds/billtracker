-- =====================================================================
-- Bill Tracker — which weeks each partner gets paid
-- Run once after schema.sql (safe to re-run).
--   payday: any one payday; the app works out the rest from pay_frequency and only
--   asks for a deposit in weeks with a payday. NULL = ask every week.
-- =====================================================================

alter table public.members add column if not exists payday date;

grant update (payday) on public.members to authenticated;
