import { Fragment, useRef, useState, type FormEvent } from 'react';
import { addDays, formatShort, todayISO } from '../logic/dates';
import { formatCents, parseDollars, centsToInput } from '../logic/money';
import { dueDates, monthlyEquivalent, nextDue, RECURRENCE_LABEL, sortByNextDue } from '../logic/recurrence';
import type { Bill, Recurrence } from '../types';
import {
  deleteBill, getState, memberName, requestOwnership, saveBill, type BillInput,
} from '../store';
import { useAppState, useBusy } from '../ui/hooks';
import { AsyncButton } from '../ui/parts';
import { confirmSheet, Sheet } from '../ui/Sheet';
import { toast } from '../ui/toast';

const CATEGORIES = ['Housing', 'Utilities', 'Insurance', 'Transportation', 'Phone & Internet', 'Subscriptions', 'Debt', 'Childcare', 'Groceries', 'Medical', 'Other'];

export function BillsView() {
  const s = useAppState();
  // null = adding a new bill
  const [editing, setEditing] = useState<{ bill: Bill | null } | null>(null);
  const [desc, setDesc] = useState(true);
  const today = todayISO();
  const bills = sortByNextDue(s.bills, today, desc);
  const active = bills.filter((b) => b.active);
  const paused = bills.filter((b) => !b.active);
  const shared = active.filter((b) => b.owner_id === null);
  const personal = active.filter((b) => b.owner_id !== null);
  const monthlyShared = shared.reduce((sum, b) => sum + monthlyEquivalent(b), 0);

  const row = (b: Bill) => {
    const next = nextDue(b, today);
    const pending = s.requests.some((r) => r.bill_id === b.id && r.status === 'pending');
    return (
      <li key={b.id} className="bill-row" tabIndex={0} role="button"
        onClick={() => setEditing({ bill: b })}
        onKeyDown={(e) => e.key === 'Enter' && setEditing({ bill: b })}>
        <div className="occ-main">
          <div className="occ-name">{b.name}
            {b.autopay && <> <span className="badge">Autopay</span></>}
            {pending && <> <span className="badge warn">Change pending</span></>}
          </div>
          <div className="occ-sub">{RECURRENCE_LABEL[b.recurrence]} · {b.category}{next ? ` · next ${formatShort(next)}` : ' · no upcoming date'}</div>
        </div>
        <div className="occ-amt">{formatCents(b.amount_cents)}</div>
        <span className="chev" aria-hidden="true">›</span>
      </li>
    );
  };

  const personalByOwner = s.members
    .map((m) => ({ m, list: personal.filter((b) => b.owner_id === m.user_id) }))
    .filter((g) => g.list.length);

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h1>Bills</h1>
          <p className="muted small">Shared bills average {formatCents(Math.round(monthlyShared))}/month</p>
        </div>
        <div className="inline">
          <button type="button" className="btn ghost" onClick={() => setDesc(!desc)}
            aria-label={`Due date, ${desc ? 'latest' : 'soonest'} first`}>
            Due date {desc ? '↓' : '↑'}
          </button>
          <button type="button" className="btn primary" onClick={() => setEditing({ bill: null })}>+ Add bill</button>
        </div>
      </div>

      <h2 className="section-title">Shared · split by income</h2>
      {shared.length ? <ul className="list">{shared.map(row)}</ul> : <p className="empty">No shared bills yet. Add rent, utilities, and so on.</p>}

      {personalByOwner.map((g) => (
        <Fragment key={g.m.user_id}>
          <h2 className="section-title">{g.m.display_name}'s personal bills</h2>
          <ul className="list">{g.list.map(row)}</ul>
        </Fragment>
      ))}

      {paused.length > 0 && (
        <>
          <h2 className="section-title muted">Paused</h2>
          <ul className="list dim">{paused.map(row)}</ul>
        </>
      )}

      {editing && <BillSheet bill={editing.bill} onClose={() => setEditing(null)} />}
    </section>
  );
}

function BillSheet({ bill, onClose }: { bill: Bill | null; onClose: () => void }) {
  const s = getState();
  const [busy, run] = useBusy();
  const [pastHint, setPastHint] = useState(false);
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
    if (bill) return;
    const f = new FormData(e.currentTarget);
    const today = todayISO();
    const start_date = String(f.get('start_date'));
    const missed = !!start_date
      && dueDates({ recurrence: f.get('recurrence') as Recurrence, start_date }, addDays(today, -60), addDays(today, -1)).length > 0;
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
        <label className="check"><input type="checkbox" name="autopay" defaultChecked={bill?.autopay} /> Autopay</label>
        {bill && <label className="check"><input type="checkbox" name="active" defaultChecked={bill.active} /> Active (uncheck to pause)</label>}

        {bill ? (
          <fieldset className="ownership">
            <legend>Who pays</legend>
            {pending ? (
              <p className="muted small">
                A request to make this bill {pending.kind === 'make_personal' ? `personal (${memberName(pending.owner_id)})` : 'shared'} is
                waiting for {pending.requested_by === s.userId ? 'your partner' : 'you — see This week'}.
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
