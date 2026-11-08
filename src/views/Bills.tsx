import { Fragment, useState } from 'react';
import { formatShort, todayISO } from '../logic/dates';
import { formatCents } from '../logic/money';
import { groupByCategory, monthlyEquivalent, nextDue, RECURRENCE_LABEL, sortByNextDue } from '../logic/recurrence';
import type { Bill } from '../types';
import { useAppState } from '../ui/hooks';
import { BillSheet } from '../ui/parts';

export function BillsView() {
  const s = useAppState();
  // null = adding a new bill
  const [editing, setEditing] = useState<{ bill: Bill | null } | null>(null);
  const [desc, setDesc] = useState(false);
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
          <div className="occ-sub">{RECURRENCE_LABEL[b.recurrence]}{next ? ` · next ${formatShort(next)}` : ' · no upcoming date'}</div>
        </div>
        <div className="occ-amt">{formatCents(b.amount_cents)}</div>
        <span className="chev" aria-hidden="true">›</span>
      </li>
    );
  };

  const grouped = (list: Bill[], dim = false) => groupByCategory(list).map(([category, bs]) => (
    <Fragment key={category}>
      <h3 className="cat-title">{category}</h3>
      <ul className={dim ? 'list dim' : 'list'}>{bs.map(row)}</ul>
    </Fragment>
  ));

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
      {shared.length ? grouped(shared) : <p className="empty">No shared bills yet. Add rent, utilities, and so on.</p>}

      {personalByOwner.map((g) => (
        <Fragment key={g.m.user_id}>
          <h2 className="section-title">{g.m.display_name}'s personal bills</h2>
          {grouped(g.list)}
        </Fragment>
      ))}

      {paused.length > 0 && (
        <>
          <h2 className="section-title muted">Paused</h2>
          {grouped(paused, true)}
        </>
      )}

      {editing && <BillSheet bill={editing.bill} onClose={() => setEditing(null)} />}
    </section>
  );
}
