-- =====================================================================
-- Bill Tracker — let a partner leave their household
-- Run once after schema.sql (safe to re-run). admin.sql builds on this file.
-- =====================================================================

-- Deletes a household and everything in it. Internal: not callable from the app.
-- Children first, so the activity-log triggers still find the household while they run.
create or replace function public.delete_household_data(p_household uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from bill_requests where household_id = p_household;
  delete from contributions where household_id = p_household;
  delete from paychecks     where household_id = p_household;
  delete from payments      where household_id = p_household;
  delete from bills         where household_id = p_household;
  delete from members       where household_id = p_household;
  delete from activity_log  where household_id = p_household;
  delete from households    where id = p_household;
end $$;

-- Removes one member from their household. Internal: not callable from the app.
-- Their deposits and paychecks are deleted and their personal bills become shared.
-- The last one out deletes the household, so nobody can join with the old invite
-- code and see its data. p_how finishes the log line: "Sam <p_how>".
create or replace function public.remove_member(p_user uuid, p_how text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_h    uuid := (select household_id from members where user_id = p_user);
  v_name text := member_name(p_user);
begin
  if v_h is null then raise exception 'Not in a household'; end if;

  -- One removal per household at a time (both partners leaving at once, or an admin removing
  -- one while the other leaves); otherwise both could see the other and leave an empty household.
  perform 1 from households where id = v_h for update;
  if not exists (select 1 from members where user_id = p_user and household_id = v_h) then
    raise exception 'Not in a household';
  end if;

  if not exists (select 1 from members where household_id = v_h and user_id <> p_user) then
    perform delete_household_data(v_h);
    return;
  end if;

  -- The cascade sets their personal bills' owner_id to null; the bills guard only allows that when flagged.
  perform set_config('app.approved_owner_change', 'on', true);
  delete from members where user_id = p_user;
  perform set_config('app.approved_owner_change', 'off', true);

  -- Drop the per-row "removed deposit/paycheck" entries the cascade just logged (now() = this transaction).
  delete from activity_log where household_id = v_h and actor is not distinct from auth.uid() and created_at = now();
  insert into activity_log (household_id, actor, message)
  values (v_h, auth.uid(), v_name || ' ' || p_how);
end $$;

revoke execute on function public.delete_household_data(uuid) from public, anon, authenticated;
revoke execute on function public.remove_member(uuid, text)   from public, anon, authenticated;

create or replace function public.leave_household()
returns void language plpgsql security definer set search_path = public as $$
begin
  if my_household() is null then raise exception 'You are not in a household'; end if;
  perform remove_member(auth.uid(), 'left the household');
end $$;

revoke execute on function public.leave_household() from public, anon;
grant  execute on function public.leave_household() to authenticated;

notify pgrst, 'reload schema';
