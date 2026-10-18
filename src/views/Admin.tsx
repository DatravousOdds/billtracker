import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  role, deleteHousehold, deleteRow, deleteUser, loadHousehold, loadOverview, removeMember, resetInviteCode, updateRow,
  type AdminHousehold, type AdminTable,
} from '../admin';
import { formatShort, todayISO } from '../logic/dates';
import { centsToInput, formatCents, parseDollars } from '../logic/money';
import { supabase } from '../supabase';
import { useBusy } from '../ui/hooks';
import { AsyncButton, You } from '../ui/parts';
import { confirmSheet, Sheet } from '../ui/Sheet';
import { errorMessage, toast } from '../ui/toast';

type Overview = Awaited<ReturnType<typeof loadOverview>>;
interface Me { userId: string; householdId: string | null }

// Support can look but not touch; the database enforces the same split.
const canEdit = () => role === 'admin';

// Timestamps are UTC; show the calendar day on this device.
const day = (ts: string) => formatShort(todayISO(new Date(ts)));
const when = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Standalone admin page: its own top bar, no household state needed. */
export function AdminPage({ me }: { me: Me }) {
  return (
    <div className="shell">
      <header className="top">
        <span className="top-title">{role === 'admin' ? 'Admin' : 'Support'}</span>
        <span className="row-actions">
          {me.householdId && <a href="#/" className="btn ghost sm">Back to app</a>}
          <button type="button" className="btn ghost sm" onClick={() => void supabase.auth.signOut()}>Sign out</button>
        </span>
      </header>
      <main id="main"><AdminView me={me} /></main>
    </div>
  );
}

function AdminView({ me }: { me: Me }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [hh, setHh] = useState<AdminHousehold | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ table: AdminTable; id: string } | null>(null);
  const loads = useRef(0); // only the newest refresh() may paint, so a slow earlier load can't overwrite it

  async function refresh(want = selected) {
    const load = ++loads.current;
    try {
      const nextOv = await loadOverview();
      const sel = want && nextOv.households.some((h) => h.id === want) ? want : null;
      const nextHh = sel ? await loadHousehold(sel) : null;
      if (load !== loads.current) return;
      setOv(nextOv);
      setHh(nextHh);
      setSelected(sel);
      setError('');
    } catch (err) {
      if (load !== loads.current) return;
      setError(errorMessage(err));
    } finally {
      if (load === loads.current) setLoading(false);
    }
  }

  useEffect(() => void refresh(null), []);

  const showLoading = (want: string | null) => {
    setLoading(true);
    setError('');
    refresh(want);
  };

  if (loading) return <section className="view"><div className="loading">Loading…</div></section>;
  if (error || !ov) {
    return (
      <section className="view">
        <p className="empty">Couldn't load: {error}</p>
        <button type="button" className="btn ghost block" onClick={() => showLoading(selected)}>Try again</button>
      </section>
    );
  }

  const memberName = (id: string | null) =>
    id === null ? 'Shared account' : ov.members.find((m) => m.user_id === id)?.display_name ?? 'Removed member';
  const emailOf = (id: string) => ov.users.find((u) => u.user_id === id)?.email ?? '';
  const householdName = (id: string | null) => ov.households.find((h) => h.id === id)?.name;

  // Your own household changed underneath the main app: start over from a clean load.
  const restart = () => { location.hash = '#/admin'; location.reload(); };

  const section = (title: string, items: ReactNode[], empty: string) => (
    <>
      <h2 className="section-title">{title}</h2>
      {items.length ? <ul className="list">{items}</ul> : <p className="empty">{empty}</p>}
    </>
  );

  // Row with Edit amount + Delete buttons, used for bills, payments, deposits and paychecks.
  const row = (table: AdminTable, id: string, name: string, sub: string, cents: number) => (
    <li className="occ" key={id}>
      <div className="occ-main"><div className="occ-name">{name}</div><div className="occ-sub">{sub}</div></div>
      <div className="occ-amt">{formatCents(cents)}</div>
      {canEdit() && (
        <>
          <button type="button" className="icon-btn" aria-label={`Edit ${name}`} onClick={() => setEditing({ table, id })}>✎</button>
          <AsyncButton className="icon-btn" aria-label={`Delete ${name}`} onClick={async () => {
            if (!await confirmSheet('Delete?', 'Delete this row for good? This can\'t be undone.', 'Delete', true)) return;
            await deleteRow(table, id);
            toast('Deleted');
            await refresh();
          }}>✕</AsyncButton>
        </>
      )}
    </li>
  );

  if (!selected || !hh) {
    const q = query.trim().toLowerCase();
    return (
      <section className="view">
        <div className="view-head"><h1>{role === 'admin' ? 'Admin' : 'Support'}</h1></div>
        <p className="muted small">{ov.users.length} users · {ov.households.length} households</p>

        <div className="card form">
          <label>Find a user <input type="search" placeholder="Email or name" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
          <ul className="list">
            {ov.users.filter((u) => `${u.email} ${u.display_name ?? ''}`.toLowerCase().includes(q)).map((u) => (
              <li className="occ" key={u.user_id}>
                <div className="occ-main">
                  <div className="occ-name">{u.email}<You show={u.user_id === me.userId} /></div>
                  <div className="occ-sub">
                    {u.display_name ? `${u.display_name} · ${householdName(u.household_id) ?? ''}` : 'No household'}
                    {u.role ? ` · ${u.role}` : ''} · last sign-in {u.last_sign_in_at ? day(u.last_sign_in_at) : 'never'}
                  </div>
                </div>
                {u.household_id && <button type="button" className="btn ghost sm" onClick={() => showLoading(u.household_id)}>Open</button>}
                {u.user_id !== me.userId && canEdit() && (
                  <AsyncButton className="icon-btn" aria-label={`Delete account ${u.email}`} onClick={async () => {
                    const ok = await confirmSheet('Delete account?',
                      `Delete ${u.email}? This removes their login and member profile, plus all their deposits and paychecks. If they're the last member of their household, it's deleted too. It can't be undone.`,
                      'Delete account', true);
                    if (!ok) return;
                    await deleteUser(u.user_id);
                    toast('Account deleted');
                    await refresh();
                  }}>✕</AsyncButton>
                )}
              </li>
            ))}
          </ul>
        </div>

        {section('Households', ov.households.map((h) => (
          <li className="occ" key={h.id}>
            <div className="occ-main">
              <div className="occ-name">{h.name}</div>
              <div className="occ-sub">
                {ov.members.filter((m) => m.household_id === h.id).map((m) => m.display_name).join(' & ') || 'No members'}
                {' '}· code {h.invite_code} · created {day(h.created_at)}
              </div>
            </div>
            <button type="button" className="btn ghost sm" onClick={() => showLoading(h.id)}>Open</button>
          </li>
        )), 'No households yet.')}
      </section>
    );
  }

  const h = ov.households.find((x) => x.id === selected)!;
  const members = ov.members.filter((m) => m.household_id === h.id);
  const billName = (id: string) => hh.bills.find((b) => b.id === id)?.name ?? 'Deleted bill';

  return (
    <section className="view">
      <div className="view-head">
        <button type="button" className="btn ghost sm" onClick={() => { setSelected(null); refresh(null); }}>← All households</button>
        <h1>{h.name}</h1>
      </div>

      <div className="card">
        <div className="invite"><code>{h.invite_code}</code>
          <AsyncButton className="btn ghost sm" onClick={async () => {
            if (!await confirmSheet('Reset invite code?', 'The old code stops working right away.', 'Reset')) return;
            toast(`New code: ${await resetInviteCode(h.id)}`);
            await refresh();
          }}>Reset invite code</AsyncButton>
        </div>
        <p className="muted small">{h.weekly_mode === 'smoothed' ? 'Smoothed' : 'Pay as due'} · created {day(h.created_at)}</p>
        {canEdit() && (
          <AsyncButton className="btn danger-ghost sm" onClick={async () => {
            const ok = await confirmSheet('Delete household?',
              `Delete ${h.name} with all its bills, payments, deposits, paychecks and activity? Members keep their logins and go back to setup. This can't be undone.`,
              'Delete household', true);
            if (!ok) return;
            await deleteHousehold(h.id);
            if (h.id === me.householdId) return restart();
            toast('Household deleted');
            await refresh(null);
          }}>Delete household</AsyncButton>
        )}
      </div>

      {section('Members', members.map((m) => (
        <li className="occ" key={m.user_id}>
          <div className="occ-main">
            <div className="occ-name">{m.display_name}<You show={m.user_id === me.userId} /></div>
            <div className="occ-sub">{emailOf(m.user_id)} · {formatCents(m.pay_amount_cents)} {m.pay_frequency}</div>
          </div>
          {canEdit() && (
            <AsyncButton className="btn ghost sm" onClick={async () => {
              const deposits = hh.contributions.filter((c) => c.member_id === m.user_id).length;
              const paychecks = hh.paychecks.filter((p) => p.member_id === m.user_id).length;
              const ok = await confirmSheet('Remove member?',
                `Removing ${memberName(m.user_id)} also deletes their ${deposits} deposits and ${paychecks} paychecks, and makes their personal bills shared. If they're the last member, the household is deleted too. Their login stays; they can join a household again.`,
                'Remove', true);
              if (!ok) return;
              await removeMember(m.user_id);
              if (m.user_id === me.userId) return restart();
              toast('Member removed');
              await refresh();
            }}>Remove</AsyncButton>
          )}
        </li>
      )), 'No members.')}

      {section('Bills', hh.bills.map((b) => row('bills', b.id, b.name,
        `${b.recurrence} · ${b.owner_id ? `personal (${memberName(b.owner_id)})` : 'shared'}${b.active ? '' : ' · paused'}`, b.amount_cents)), 'No bills.')}
      {section('Payments', hh.payments.map((p) => row('payments', p.id, billName(p.bill_id),
        `due ${formatShort(p.due_date)} · paid ${formatShort(p.paid_on)} by ${memberName(p.paid_by)}`, p.amount_cents)), 'No payments.')}
      {section('Deposits', hh.contributions.map((c) => row('contributions', c.id, memberName(c.member_id),
        `week of ${formatShort(c.week_start)}`, c.amount_cents)), 'No deposits.')}
      {section('Paychecks', hh.paychecks.map((p) => row('paychecks', p.id, memberName(p.member_id),
        `paid ${formatShort(p.paid_on)}`, p.amount_cents)), 'No paychecks.')}

      <h2 className="section-title">Recent activity</h2>
      {hh.activity.length ? (
        <ul className="list feed">{hh.activity.map((a) => (
          <li key={a.id}><div>{a.message}</div><div className="muted small">{when.format(new Date(a.created_at))}</div></li>
        ))}</ul>
      ) : <p className="empty">No activity yet.</p>}

      {editing && (
        <EditSheet hh={hh} members={members} table={editing.table} id={editing.id}
          onClose={() => setEditing(null)} onSaved={() => refresh()} />
      )}
    </section>
  );
}

function EditSheet({ hh, members, table, id, onClose, onSaved }: {
  hh: AdminHousehold; members: Overview['members']; table: AdminTable; id: string; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [busy, run] = useBusy();
  const current = (hh[table] as { id: string; amount_cents: number }[]).find((r) => r.id === id);
  const bill = table === 'bills' ? hh.bills.find((b) => b.id === id) : undefined;
  if (!current) return null;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const amount = parseDollars(String(f.get('amount')));
    if (amount === null) return toast('Enter an amount like 120.50', 'error');
    const patch: Record<string, unknown> = { amount_cents: amount };
    if (bill) patch.owner_id = String(f.get('owner')) || null;
    run(async () => {
      await updateRow(table, id, patch);
      onClose();
      toast('Saved');
      await onSaved();
    });
  };

  return (
    <Sheet title="Edit" onClose={onClose}>
      <form className="sheet-body form" onSubmit={submit}>
        <label>Amount <input name="amount" inputMode="decimal" required defaultValue={centsToInput(current.amount_cents)} /></label>
        {bill && (
          <label>Who pays
            <select name="owner" defaultValue={bill.owner_id ?? ''}>
              <option value="">Shared (split by income)</option>
              {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name} (personal)</option>)}
            </select>
          </label>
        )}
        <button className="btn primary block" type="submit" disabled={busy}>Save</button>
      </form>
    </Sheet>
  );
}
