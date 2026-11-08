-- =====================================================================
-- Bill Tracker — log payment edits in Activity
-- Run once after schema.sql (safe to re-run).
-- =====================================================================

create or replace function public.log_payment_edit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  changes text[] := '{}';
  v_bill  text;
begin
  -- Deleting a member nulls paid_by through the foreign key. Nobody edited anything.
  if old.paid_by is not null and not exists (select 1 from members where user_id = old.paid_by) then
    return new;
  end if;

  if new.amount_cents <> old.amount_cents then
    changes := changes || (fmt_cents(old.amount_cents) || ' → ' || fmt_cents(new.amount_cents));
  end if;
  if new.paid_on <> old.paid_on then
    changes := changes || ('paid on ' || to_char(old.paid_on, 'Mon FMDD') || ' → ' || to_char(new.paid_on, 'Mon FMDD'));
  end if;
  if new.paid_by is distinct from old.paid_by then
    changes := changes || ('paid from ' ||
      case when old.paid_by is null then 'Shared account' else member_name(old.paid_by) end || ' → ' ||
      case when new.paid_by is null then 'Shared account' else member_name(new.paid_by) end);
  end if;

  if array_length(changes, 1) > 0 then
    select name into v_bill from bills where id = new.bill_id;
    insert into activity_log (household_id, actor, message)
    values (new.household_id, auth.uid(),
            member_name(auth.uid()) || ' edited ' || v_bill || ' (due ' || to_char(new.due_date, 'Mon FMDD') || '): ' ||
            array_to_string(changes, ', '));
  end if;
  return new;
end $$;

drop trigger if exists log_payment_edit on public.payments;
create trigger log_payment_edit after update on public.payments
for each row execute function public.log_payment_edit();
