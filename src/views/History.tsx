import { useState } from 'react';
import { formatShort } from '../logic/dates';
import { formatCents } from '../logic/money';
import { ledger } from '../logic/split';
import { deleteContribution, memberName, shares, unmarkPaid } from '../store';
import { useAppState } from '../ui/hooks';
import { AsyncButton, pct } from '../ui/parts';
import { toast } from '../ui/toast';

type Tab = 'payments' | 'deposits' | 'activity';
let rememberedTab: Tab = 'payments'; // remembered while the app is open

const when = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function HistoryView() {
  const s = useAppState();
  const [tab, setTab] = useState(rememberedTab);
  const sh = shares();
  const led = ledger(s.bills, s.payments, s.contributions, sh);
  const billName = (id: string) => s.bills.find((b) => b.id === id)?.name ?? 'Deleted bill';
  const payments = [...s.payments].sort((a, b) => b.paid_on.localeCompare(a.paid_on) || b.due_date.localeCompare(a.due_date));

  const body = {
    payments: () => payments.length ? (
      <ul className="list">{payments.map((p) => (
        <li className="occ" key={p.id}>
          <div className="occ-main">
            <div className="occ-name">{billName(p.bill_id)}</div>
            <div className="occ-sub">Paid {formatShort(p.paid_on)} by {memberName(p.paid_by)} · due {formatShort(p.due_date)}</div>
          </div>
          <div className="occ-amt">{formatCents(p.amount_cents)}</div>
          <AsyncButton className="icon-btn" aria-label="Undo payment" onClick={async () => {
            await unmarkPaid(p.id);
            toast('Payment removed');
          }}>↺</AsyncButton>
        </li>
      ))}</ul>
    ) : <p className="empty">No payments yet.</p>,

    deposits: () => s.contributions.length ? (
      <ul className="list">{s.contributions.map((c) => (
        <li className="occ" key={c.id}>
          <div className="occ-main">
            <div className="occ-name">{memberName(c.member_id)}</div>
            <div className="occ-sub">Week of {formatShort(c.week_start)}</div>
          </div>
          <div className="occ-amt">{formatCents(c.amount_cents)}</div>
          {c.member_id === s.userId && (
            <AsyncButton className="icon-btn" aria-label="Remove deposit" onClick={async () => {
              await deleteContribution(c.id);
              toast('Deposit removed');
            }}>✕</AsyncButton>
          )}
        </li>
      ))}</ul>
    ) : <p className="empty">No deposits yet. Confirm yours from This week.</p>,

    activity: () => s.activity.length ? (
      <ul className="list feed">{s.activity.map((a) => (
        <li key={a.id}><div>{a.message}</div><div className="muted small">{when.format(new Date(a.created_at))}</div></li>
      ))}</ul>
    ) : <p className="empty">No activity yet.</p>,
  } satisfies Record<Tab, () => unknown>;

  return (
    <section className="view">
      <div className="view-head"><h1>History</h1></div>

      <div className="card">
        <div className="eyebrow">Running balance</div>
        <table className="ledger">
          <thead><tr><th></th><th>Put in</th><th>Fair share</th><th>Balance</th></tr></thead>
          <tbody>{led.balances.map((b) => (
            <tr key={b.member.user_id}>
              <th>{b.member.display_name} <span className="muted small">{pct(sh.find((x) => x.member.user_id === b.member.user_id)?.ratio ?? 0)}</span></th>
              <td>{formatCents(b.putInCents)}</td>
              <td>{formatCents(b.fairShareCents)}</td>
              <td className={b.balanceCents > 0 ? 'pos' : b.balanceCents < 0 ? 'neg' : ''}>{b.balanceCents > 0 ? '+' : ''}{formatCents(b.balanceCents)}</td>
            </tr>
          ))}</tbody>
        </table>
        <p className="muted small">"Put in" = bill-account deposits + shared bills paid directly. Fair share uses today's split. Bill account holds {formatCents(led.accountCents)}.</p>
      </div>

      <div className="seg full" role="tablist">
        {(['payments', 'deposits', 'activity'] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" className={tab === t ? 'on' : ''} onClick={() => setTab(rememberedTab = t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className="tab-body">{body[tab]()}</div>
    </section>
  );
}
