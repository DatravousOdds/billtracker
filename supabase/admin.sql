-- =====================================================================
-- Bill Tracker — app-owner admin and support access
-- Run once after schema.sql and leave.sql (safe to re-run). Then make yourself the first admin:
--   insert into public.app_roles (user_id, role)
--   select id, 'admin' from auth.users where email = 'you@example.com';
-- After that, admins grant roles from the app (Settings → Account roles).
-- Deploy the app build that filters load() by household_id BEFORE adding a role row,
-- or a staff member's normal app view would mix in every household's data.
--
-- Roles:  admin   — see and change everything, manage roles
--         support — see everything, reset invite codes; no edits or deletes
--         user    — no row in app_roles; household-only access from schema.sql
-- =====================================================================

begin;
set local lock_timeout = '5s';

-- An earlier version of this file called the table "admins" (admin-only, no role column).
do $$
begin
  if to_regclass('public.admins') is not null and to_regclass('public.app_roles') is null then
    alter table public.admins rename to app_roles;
  end if;
end $$;

-- Who has a staff role. RLS on with no policies: clients can't read or change it directly.
create table if not exists public.app_roles (
  user_id uuid primary key references auth.users (id) on delete cascade
);
alter table public.app_roles add column if not exists role text not null default 'admin'
  check (role in ('admin', 'support'));
alter table public.app_roles enable row level security;
revoke all on public.app_roles from anon, authenticated;

-- The signed-in user's role: 'admin', 'support', or null.
create or replace function public.app_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.app_roles where user_id = auth.uid()
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.app_role() = 'admin', false)
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select public.app_role() is not null
$$;

-- Admins can change every row; support can read every row. Permissive policies are OR'ed,
-- so everyone else keeps the household-only rules from schema.sql.
do $$
declare t text;
begin
  foreach t in array array['households', 'members', 'bills', 'payments', 'contributions',
                           'paychecks', 'bill_requests', 'activity_log'] loop
    execute format('drop policy if exists "admin all" on public.%I', t);
    execute format('create policy "admin all" on public.%I for all
                    using ((select public.is_admin())) with check ((select public.is_admin()))', t);
    execute format('drop policy if exists "staff read" on public.%I', t);
    execute format('create policy "staff read" on public.%I for select using ((select public.is_staff()))', t);
  end loop;
end $$;

-- Activity log names staff who aren't in the household "Admin"/"Support" instead of "Someone".
create or replace function public.member_name(uid uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select display_name from public.members where user_id = uid),
    (select initcap(role) from public.app_roles where user_id = uid),
    'Someone')
$$;
-- Only the security-definer triggers/functions call this; don't expose it as an RPC
-- (it would reveal any user's name, or their role, from their id).
revoke execute on function public.member_name(uuid) from public, anon, authenticated;

-- Same as schema.sql, except an admin may change owner_id directly (also lets
-- the owner_id "set null" cascade through when an admin removes a member).
create or replace function public.bills_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.owner_id is not null then
      raise exception 'New bills start shared. Request to make it personal afterwards.';
    end if;
  elsif tg_op = 'UPDATE' then
    if new.owner_id is distinct from old.owner_id
       and coalesce(current_setting('app.approved_owner_change', true), 'off') <> 'on'
       and not public.is_admin() then
      raise exception 'Changing who owns a bill needs your partner''s approval';
    end if;
    if new.household_id <> old.household_id then
      raise exception 'Bills cannot move between households';
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;

-- Every user with their email and role (clients can't read auth.users). Staff only.
-- Dropped first: the earlier version had no role column, and the return type can't change in place.
drop function if exists public.admin_users();
create function public.admin_users()
returns table (user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz,
               household_id uuid, display_name text, role text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'Not allowed'; end if;
  return query
    select u.id, u.email::text, u.created_at, u.last_sign_in_at, m.household_id, m.display_name, r.role
      from auth.users u
      left join public.members m on m.user_id = u.id
      left join public.app_roles r on r.user_id = u.id
     order by u.created_at desc;
end $$;

-- Admin only. 'user' removes the staff role. You can't change your own role,
-- so the last admin can't lock everyone out.
create or replace function public.admin_set_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Not allowed'; end if;
  if p_user = auth.uid() then raise exception 'You can''t change your own role'; end if;
  if p_role not in ('admin', 'support', 'user') then raise exception 'Unknown role %', p_role; end if;
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'User not found'; end if;
  if p_role = 'user' then
    delete from app_roles where user_id = p_user;
  else
    insert into app_roles (user_id, role) values (p_user, p_role)
    on conflict (user_id) do update set role = excluded.role;
  end if;
end $$;

-- Same path as leaving (leave.sql): the last member out takes the household with them.
create or replace function public.admin_remove_member(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Not allowed'; end if;
  perform remove_member(p_user, 'was removed by an admin');
end $$;

-- Deletes the login. Leaves their household first, then the cascade removes their role.
create or replace function public.admin_delete_user(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Not allowed'; end if;
  if p_user = auth.uid() then raise exception 'You can''t delete your own account here'; end if;
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'User not found'; end if;
  if exists (select 1 from members where user_id = p_user) then
    perform remove_member(p_user, 'was removed by an admin');
  end if;
  delete from auth.users where id = p_user;
end $$;

create or replace function public.admin_delete_household(p_household uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from households where id = p_household) then raise exception 'Household not found'; end if;
  perform delete_household_data(p_household);
end $$;

-- Staff (admin or support).
create or replace function public.admin_reset_invite_code(p_household uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_code text;
begin
  if not is_staff() then raise exception 'Not allowed'; end if;
  loop
    v_code := upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 6));
    exit when not exists (select 1 from households where invite_code = v_code);
  end loop;
  update households set invite_code = v_code where id = p_household;
  if not found then raise exception 'Household not found'; end if;
  return v_code;
end $$;

revoke execute on function public.admin_users()                  from public, anon;
revoke execute on function public.admin_set_role(uuid, text)     from public, anon;
revoke execute on function public.admin_remove_member(uuid)      from public, anon;
revoke execute on function public.admin_delete_user(uuid)        from public, anon;
revoke execute on function public.admin_delete_household(uuid)   from public, anon;
revoke execute on function public.admin_reset_invite_code(uuid)  from public, anon;
grant  execute on function public.admin_users()                  to authenticated;
grant  execute on function public.admin_set_role(uuid, text)     to authenticated;
grant  execute on function public.admin_remove_member(uuid)      to authenticated;
grant  execute on function public.admin_delete_user(uuid)        to authenticated;
grant  execute on function public.admin_delete_household(uuid)   to authenticated;
grant  execute on function public.admin_reset_invite_code(uuid)  to authenticated;

commit;

-- Make the new functions visible to the API right away.
notify pgrst, 'reload schema';
