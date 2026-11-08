// Shared UI pieces used by several screens.
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type FormEvent } from 'react';
import { addDays, formatLong, formatShort, todayISO } from '../logic/dates';
import { formatCents, parseDollars, centsToInput } from '../logic/money';
import { dueDates, RECURRENCE_LABEL } from '../logic/recurrence';
import { needsConfirming, newlyOverdue, paycheckWeek, type Occurrence } from '../logic/split';
import {
  deleteBill, getState, homeName, markPaid, memberName, requestOwnership, saveBalance, saveBill, unmarkPaid, updatePayment, type BillInput,
} from '../store';
import type { Bill, ISODate, Payment, Recurrence } from '../types';
import { useBusy } from './hooks';
import { confirmSheet, Sheet } from './Sheet';
import { toast } from './toast';
import { depositCreditEnabled } from '../supabase';

const CATEGORIES = ['Housing', 'Utilities', 'Insurance', 'Transportation', 'Phone & Internet', 'Subscriptions', 'Debt', 'Childcare', 'Groceries', 'Medical', 'Other'];

/** A button that runs an async action, disabled while it runs. Errors show as a toast. */
export function AsyncButton({ onClick, disabled, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  onClick: () => Promise<unknown>;
}) {
  const [busy, run] = useBusy();
  return <button type="button" {...props} disabled={busy || disabled} onClick={() => run(onClick)} />;
}

/** " (you)" after your own name. */
export const You = ({ show }: { show: boolean }) => (show ? <> <span className="muted">(you)</span></> : null);

export function BillBadges({ bill }: { bill: Bill }) {
  const s = getState();
  const pending = s.requests.some((r) => r.bill_id === bill.id && r.status === 'pending');
  return (
    <>
      {bill.owner_id && <> <span className="badge personal">{memberName(bill.owner_id)}'s</span></>}
      {bill.autopay && <> <span className="badge">Autopay</span></>}
      {pending && <> <span className="badge warn">Change pending</span></>}
    </>
  );
}

/** One bill due date as a list row. Tapping edits its payment or, if unpaid, its bill. */
export function OccurrenceRow({ o, today = todayISO() }: { o: Occurrence; today?: string }) {
  const [sheet, setSheet] = useState<'pay' | 'bill' | null>(null);
  const overdue = !o.payment && !o.bill.autopay && o.date < today;
  const payment = o.payment;
  return (
    <li className={`occ ${overdue ? 'is-overdue' : ''} ${payment ? 'is-paid' : ''}`}>
      <button type="button" className="occ-tap" aria-haspopup="dialog" onClick={() => setSheet(payment ? 'pay' : 'bill')}>
        <span className="occ-main">
          <span className="occ-name">{o.bill.name}<BillBadges bill={o.bill} /></span>
          <span className="occ-sub">
            {overdue && <><strong>Overdue</strong> · </>}
            <span className="nowrap">{formatLong(o.date)}</span>
            {payment && <span className="muted"> · {formatCents(payment.amount_cents)} by {memberName(payment.paid_by)}</span>}
          </span>
        </span>
        <span className="occ-amt">{formatCents(payment?.amount_cents ?? o.bill.amount_cents)}</span>
      </button>
      <button type="button" className={`pill ${payment ? 'paid' : overdue ? 'overdue' : ''}`} aria-haspopup="dialog"
        aria-label={payment ? 'Paid. Tap to edit' : undefined} onClick={() => setSheet('pay')}>
        {payment ? '✓ Paid' : 'Confirm paid'}
      </button>
      {sheet === 'pay' && <PaySheet bill={o.bill} dueDate={o.date} payment={payment} onClose={() => setSheet(null)} />}
      {sheet === 'bill' && <BillSheet bill={o.bill} onClose={() => setSheet(null)} />}
    </li>
  );
}

/** Confirm a due date as paid or, given its payment, edit that payment. */
export function PaySheet({ bill, dueDate, payment: opened, onClose }: { bill: Bill; dueDate: string; payment?: Payment; onClose: () => void }) {
  // Fixed at open: if a partner's payment arrives mid-form, saving must not turn a confirm into an overwrite of theirs.
  const [payment] = useState(opened);
  const s = getState();
  const [busy, run] = useBusy();
  const defaultPayer = payment ? payment.paid_by ?? '' : bill.owner_id ?? (s.household.weekly_mode === 'smoothed' ? '' : s.userId);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const amount = parseDollars(String(f.get('amount')));
    if (amount === null) return toast('Enter an amount like 120.50', 'error');
    const paidBy = (f.get('paid_by') as string) || null;
    const paidOn = String(f.get('paid_on'));
    run(async () => {
      if (payment) await updatePayment(payment.id, { amount_cents: amount, paid_on: paidOn, paid_by: paidBy });
      else await markPaid(bill, dueDate, amount, paidBy, paidOn);
      onClose();
      toast(payment ? 'Payment updated' : `${bill.name} confirmed paid`);
    });
  };

  return (
    <Sheet title={payment ? 'Edit payment' : 'Confirm payment'} onClose={onClose}>
      <form className="sheet-body form" onSubmit={submit}>
        <p className="muted">{bill.name} · due {formatLong(dueDate)}</p>
        <label>Amount paid
          <input name="amount" inputMode="decimal" required defaultValue={centsToInput(payment?.amount_cents ?? bill.amount_cents)} />
        </label>
        <label>Paid from
          <select name="paid_by" defaultValue={defaultPayer}>
            <option value="">Shared account</option>
            {s.members.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}
          </select>
        </label>
        <label>Paid on
          <input name="paid_on" type="date" required min="1900-01-01" max="9999-12-31" defaultValue={payment?.paid_on ?? todayISO()} />
        </label>
        <button className="btn primary block" type="submit" disabled={busy}>{payment ? 'Save changes' : "Yes, it's paid"}</button>
        {payment && (
          <AsyncButton className="btn danger-ghost block" disabled={busy} onClick={async () => {
            if (!await confirmSheet('Remove payment?', `${bill.name}, due ${formatShort(dueDate)}, will go back to not paid.`, 'Remove', true)) return;
            await unmarkPaid(payment.id);
            onClose();
            toast('Payment removed');
          }}>Remove payment</AsyncButton>
        )}
      </form>
    </Sheet>
  );
}

export function BillSheet({ bill, onClose }: { bill: Bill | null; onClose: () => void }) {
  const s = getState();
  const [busy, run] = useBusy();
  const [pastHint, setPastHint] = useState(false);
  const [overdueCount, setOverdueCount] = useState(0);
  const ownerRef = useRef<HTMLSelectElement>(null);
  const pending = bill ? s.requests.find((r) => r.bill_id === bill.id && r.status === 'pending') : undefined;

  const request = (kind: 'make_personal' | 'make_shared') => async () => {
    if (!bill) return;
    await requestOwnership(bill.id, kind, kind === 'make_personal' ? ownerRef.current!.value : null);
    onClose();
    toast('Request sent to your partner');
  };

  const remove = async () => {
    if (!bill) return;
    if (!await confirmSheet('Delete bill?', `Delete ${bill.name} and its payment history? Pausing keeps the history.`, 'Delete', true)) return;
    await deleteBill(bill.id);
    onClose();
    toast('Bill deleted');
  };

  // Matches needsConfirming: only a missed due date in the last 60 days, and never on autopay, shows as overdue.
  const onInput = (e: FormEvent<HTMLFormElement>) => {
    const f = new FormData(e.currentTarget);
    const today = todayISO();
    const start_date = String(f.get('start_date'));
    const recurrence = f.get('recurrence') as Recurrence;
    if (bill) {
      setOverdueCount(newlyOverdue(bill, { ...bill, recurrence, start_date, autopay: f.get('autopay') === 'on', active: f.get('active') === 'on' }, s.payments, today));
      return;
    }
    const missed = !!start_date
      && dueDates({ recurrence, start_date }, addDays(today, -60), addDays(today, -1)).length > 0;
    setPastHint(missed && f.get('autopay') !== 'on');
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const amount = parseDollars(String(f.get('amount')));
    if (amount === null) return toast('Enter an amount like 120.50', 'error');
    const input: BillInput = {
      name: String(f.get('name')).trim(),
      amount_cents: amount,
      recurrence: f.get('recurrence') as Recurrence,
      start_date: String(f.get('start_date')),
      category: String(f.get('category')).trim() || 'Other',
      autopay: f.get('autopay') === 'on',
      active: bill ? f.get('active') === 'on' : true,
    };
    run(async () => {
      await saveBill(bill?.id ?? null, input);
      onClose();
      toast(bill ? 'Bill updated' : 'Bill added');
    });
  };

  return (
    <Sheet title={bill ? 'Edit bill' : 'Add bill'} onClose={onClose}>
      <form className="sheet-body form" onSubmit={submit} onInput={onInput}>
        {bill && <p className="muted small">Changes apply to every date of this bill. Past payments keep their amounts.</p>}
        <label>Name
          <input name="name" required maxLength={80} defaultValue={bill?.name ?? ''} placeholder="Rent" />
        </label>
        <div className="grid2">
          <label>Amount
            <input name="amount" inputMode="decimal" required defaultValue={bill ? centsToInput(bill.amount_cents) : ''} placeholder="0.00" />
          </label>
          <label>Repeats
            <select name="recurrence" defaultValue={bill?.recurrence ?? 'monthly'}>
              {(Object.keys(RECURRENCE_LABEL) as Recurrence[]).map((r) => <option key={r} value={r}>{RECURRENCE_LABEL[r]}</option>)}
            </select>
          </label>
        </div>
        <div className="grid2">
          <label>{bill ? 'First due date' : 'Next due date'}
            <input name="start_date" type="date" required min="1900-01-01" max="9999-12-31" defaultValue={bill?.start_date ?? todayISO()} />
          </label>
          <label>Category
            <input name="category" list="categories" defaultValue={bill?.category ?? ''} placeholder="Other" />
            <datalist id="categories">
              {[...new Set([...CATEGORIES, ...s.bills.map((b) => b.category)])].map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
        </div>
        {pastHint && <p className="muted small">This date has passed. It will show as overdue until you confirm it's paid.</p>}
        {overdueCount > 0 && <p className="card note" role="status">{overdueCount === 1 ? '1 past date' : `${overdueCount} past dates`} will show as overdue. To change only future dates, make your next due date the first due date.</p>}
        <label className="check"><input type="checkbox" name="autopay" defaultChecked={bill?.autopay} /> Autopay</label>
        {bill && <label className="check"><input type="checkbox" name="active" defaultChecked={bill.active} /> Active (uncheck to pause)</label>}

        {bill ? (
          <fieldset className="ownership">
            <legend>Who pays</legend>
            {pending ? (
              <p className="muted small">
                A request to make this bill {pending.kind === 'make_personal' ? `personal (${memberName(pending.owner_id)})` : 'shared'} is
                waiting for {pending.requested_by === s.userId ? 'your partner' : `you — see ${homeName()}`}.
              </p>
            ) : bill.owner_id === null ? (
              <>
                <p className="muted small">Shared bills are split by income. To make this one personal, your partner has to approve.</p>
                <div className="inline">
                  <select ref={ownerRef} aria-label="Who pays all of it">
                    {s.members.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name} pays all</option>)}
                  </select>
                  <AsyncButton className="btn ghost sm" onClick={request('make_personal')}>Request</AsyncButton>
                </div>
              </>
            ) : (
              <>
                <p className="muted small">Personal — {memberName(bill.owner_id)} pays all of it.</p>
                <AsyncButton className="btn ghost sm" onClick={request('make_shared')}>Request to split it again</AsyncButton>
              </>
            )}
          </fieldset>
        ) : <p className="muted small">New bills start shared. You can ask to make one personal after saving.</p>}

        <button className="btn primary block" type="submit" disabled={busy}>{bill ? 'Save changes' : 'Add bill'}</button>
        {bill && <AsyncButton className="btn danger-ghost block" onClick={remove}>Delete bill</AsyncButton>}
      </form>
    </Sheet>
  );
}

/** Type what the bank shows, for the balance in use or, from History, for `week`. */
export function BalanceSheet({ week, onClose }: { week?: ISODate; onClose: () => void }) {
  const s = getState();
  const [busy, run] = useBusy();
  const input = useRef<HTMLInputElement>(null);
  // autoFocus does nothing here: the dialog only opens in Sheet's effect, which runs before this one.
  useEffect(() => input.current?.focus(), []);
  const today = todayISO();
  const inUse = paycheckWeek(s.members.find((m) => m.user_id === s.userId)!, today);
  const current = s.household.weekly_mode === 'due' && (week ?? inUse) === inUse;
  const row = s.accountBalances.find((b) => b.member_id === s.userId && b.week_start === (week ?? inUse));

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const cents = parseDollars(String(new FormData(e.currentTarget).get('amount')));
    if (cents === null) return toast('Enter an amount like 350.00', 'error');
    run(async () => {
      const after = await saveBalance(cents, week);
      onClose();
      toast(current && !depositCreditEnabled ? `Balance saved. Your deposit is now ${formatCents(after.cents)}` : 'Balance saved');
    });
  };

  return (
    <Sheet title={week ? 'Edit balance' : "What's in the bill account?"} onClose={onClose}>
      <form className="sheet-body form" onSubmit={submit}>
        <p className="muted">
          {!week ? "Type what the shared bill account shows right now, before you deposit. We'll use it to work out your deposit."
            : current ? 'This balance is in use. Changing it updates your deposit.'
            : "This only corrects the record. Past deposits won't change."}
        </p>
        {current && needsConfirming(s.bills, s.payments, today).some((o) => o.bill.owner_id === null) && (
          <p className="sheet-warn">Confirm anything already paid first, or this will look short.</p>
        )}
        <label>{week && row ? `Balance on ${formatShort(todayISO(new Date(row.entered_at)))}` : 'Shared account balance'}
          <input ref={input} name="amount" inputMode="decimal" required defaultValue={row ? centsToInput(row.amount_cents) : ''} />
        </label>
        <button className="btn primary block" type="submit" disabled={busy}>Save balance</button>
      </form>
    </Sheet>
  );
}

/** The latest balance either partner typed. Enter it from `onEnter` or `enterHref` when nobody has. */
export function BillAccountLine({ onEnter, enterHref }: { onEnter?: () => void; enterHref?: string }) {
  const latest = getState().accountBalances[0];
  if (latest) {
    return <div className="account-line">Bill account: {formatCents(latest.amount_cents)} · entered {formatShort(todayISO(new Date(latest.entered_at)))} by {memberName(latest.member_id)}</div>;
  }
  return (
    <div className="account-line">
      <span>Bill account: Not entered yet</span>
      {onEnter && <button type="button" className="link-btn" aria-haspopup="dialog" onClick={onEnter}>Enter it</button>}
      {enterHref && <a className="link-btn" href={enterHref}>Enter it</a>}
    </div>
  );
}

export function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1).replace(/\.0$/, '')}%`;
}
