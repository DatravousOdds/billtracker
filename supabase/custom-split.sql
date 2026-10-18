-- =====================================================================
-- Bill Tracker — a split both partners agreed on, instead of by income
-- Run once after schema.sql (safe to re-run).
--   split_member/split_percent: the agreed split (split_member pays split_percent%,
--     the partner pays the rest). NULL = split by income.
--   split_proposed_by/split_proposed_percent: a change waiting for the partner.
--     A NULL percent with a proposer means "go back to splitting by income".
-- Changed only through propose_split() and decide_split(), never directly.
-- =====================================================================

alter table public.households
  add column if not exists split_member           uuid references public.members (user_id) on delete set null,
  add column if not exists split_percent          smallint check (split_percent between 1 and 99),
  add column if not exists split_proposed_by      uuid references public.members (user_id) on delete set null,
  add column if not exists split_proposed_percent smallint check (split_proposed_percent between 1 and 99);

-- Ask your partner to approve a split: p_percent is YOUR share (1–99), NULL = back to income.
-- Sending again replaces your own waiting request.
create or replace function public.propose_split(p_percent int)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_h       uuid := my_household();
  v_partner uuid;
begin
  if v_h is null then raise exception 'Not in a household'; end if;
  if p_percent is not null and p_percent not between 1 and 99 then
    raise exception 'Pick a share between 1 and 99 percent';
  end if;
  select user_id into v_partner from members where household_id = v_h and user_id <> auth.uid() limit 1;
  if v_partner is null then raise exception 'Your partner needs to join first'; end if;

  update households set split_proposed_by = auth.uid(), split_proposed_percent = p_percent
   where id = v_h and (split_proposed_by is null or split_proposed_by = auth.uid());
  if not found then raise exception 'Your partner already asked for a split change. Approve or decline it first.'; end if;

  insert into activity_log (household_id, actor, message)
  values (v_h, auth.uid(), member_name(auth.uid()) ||
          case when p_percent is null then ' asked to go back to splitting bills by income'
               else ' asked to split shared bills ' || p_percent || '% ' || member_name(auth.uid()) ||
                    ' / ' || (100 - p_percent) || '% ' || member_name(v_partner) end);
end $$;

-- Same rules as decide_request: the partner approves or declines, the requester can cancel.
create or replace function public.decide_split(p_decision text)
returns void language plpgsql security definer set search_path = public as $$
declare
  h households%rowtype;
begin
  select * into h from households where id = my_household() for update;
  if h.id is null or h.split_proposed_by is null then raise exception 'No split change is waiting'; end if;

  if p_decision = 'cancelled' then
    if h.split_proposed_by <> auth.uid() then raise exception 'Only the requester can cancel'; end if;
  elsif p_decision in ('approved', 'declined') then
    if h.split_proposed_by = auth.uid() then raise exception 'Your partner has to approve this, not you'; end if;
  else
    raise exception 'Unknown decision %', p_decision;
  end if;

  update households
     set split_member  = case when p_decision <> 'approved' then split_member
                              when h.split_proposed_percent is null then null
                              else h.split_proposed_by end,
         split_percent = case when p_decision = 'approved' then h.split_proposed_percent else split_percent end,
         split_proposed_by = null, split_proposed_percent = null
   where id = h.id;

  insert into activity_log (household_id, actor, message)
  values (h.id, auth.uid(), member_name(auth.uid()) || ' ' || p_decision || ' the ' ||
          case when h.split_proposed_percent is null then 'request to split bills by income'
               else h.split_proposed_percent || '/' || (100 - h.split_proposed_percent) || ' bill split' end);
end $$;

-- A partner leaving ends the agreement, so whoever joins next starts from the income split
-- instead of inheriting a percentage they never approved.
create or replace function public.reset_split_on_leave()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update households
     set split_member = null, split_percent = null, split_proposed_by = null, split_proposed_percent = null
   where id = old.household_id
     and (split_member is not null or split_proposed_by is not null);
  return old;
end $$;

drop trigger if exists reset_split_on_leave on public.members;
create trigger reset_split_on_leave after delete on public.members
  for each row execute function public.reset_split_on_leave();

revoke execute on function public.propose_split(int) from public, anon;
revoke execute on function public.decide_split(text) from public, anon;
grant  execute on function public.propose_split(int) to authenticated;
grant  execute on function public.decide_split(text) to authenticated;
