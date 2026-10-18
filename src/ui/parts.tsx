// Shared UI pieces used by several screens.
import { useState, type ButtonHTMLAttributes, type FormEvent } from 'react';
import { formatLong, todayISO } from '../logic/dates';
import { formatCents, parseDollars, centsToInput } from '../logic/money';
import type { Occurrence } from '../logic/split';
import { getState, markPaid, memberName, unmarkPaid } from '../store';
import type { Bill } from '../types';
import { useBusy } from './hooks';
import { Sheet } from './Sheet';
import { toast } from './toast';

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

/** One bill due date as a list row with a paid toggle. */
export function OccurrenceRow({ o, today = todayISO() }: { o: Occurrence; today?: string }) {
  const [paying, setPaying] = useState(false);
  const overdue = !o.payment && !o.bill.autopay && o.date < today;
  const payment = o.payment;
  return (
    <li className={`occ ${overdue ? 'is-overdue' : ''} ${payment ? 'is-paid' : ''}`}>
      <div className="occ-main">
        <div className="occ-name">{o.bill.name}<BillBadges bill={o.bill} /></div>
        <div className="occ-sub">
          {overdue && <><strong>Overdue</strong> · </>}
          {formatLong(o.date)}
          {payment && <span className="muted"> · {formatCents(payment.amount_cents)} by {memberName(payment.paid_by)}</span>}
        </div>
      </div>
      <div className="occ-amt">{formatCents(o.bill.amount_cents)}</div>
      {payment ? (
        <AsyncButton className="pill paid" aria-label="Paid. Tap to undo" onClick={async () => {
          await unmarkPaid(payment.id);
          toast('Marked as not paid');
        }}>✓ Paid</AsyncButton>
      ) : (
        <button type="button" className={`pill ${overdue ? 'overdue' : ''}`} onClick={() => setPaying(true)}>Confirm paid</button>
      )}
      {paying && <PaySheet bill={o.bill} dueDate={o.date} onClose={() => setPaying(false)} />}
    </li>
  );
}

function PaySheet({ bill, dueDate, onClose }: { bill: Bill; dueDate: string; onClose: () => void }) {
  const s = getState();
  const [busy, run] = useBusy();
  const defaultPayer = bill.owner_id ?? (s.household.weekly_mode === 'smoothed' ? '' : s.userId);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const amount = parseDollars(String(f.get('amount')));
    if (amount === null) return toast('Enter an amount like 120.50', 'error');
    run(async () => {
      await markPaid(bill, dueDate, amount, (f.get('paid_by') as string) || null, String(f.get('paid_on')));
      onClose();
      toast(`${bill.name} confirmed paid`);
    });
  };

  return (
    <Sheet title="Confirm payment" onClose={onClose}>
      <form className="sheet-body form" onSubmit={submit}>
        <p className="muted">{bill.name} · due {formatLong(dueDate)}</p>
        <label>Amount paid
          <input name="amount" inputMode="decimal" required defaultValue={centsToInput(bill.amount_cents)} />
        </label>
        <label>Paid from
          <select name="paid_by" defaultValue={defaultPayer}>
            <option value="">Shared bill account</option>
            {s.members.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}
          </select>
        </label>
        <label>Paid on
          <input name="paid_on" type="date" required defaultValue={todayISO()} />
        </label>
        <button className="btn primary block" type="submit" disabled={busy}>Yes, it's paid</button>
      </form>
    </Sheet>
  );
}

export function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1).replace(/\.0$/, '')}%`;
}
