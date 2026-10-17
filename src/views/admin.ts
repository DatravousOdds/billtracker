import {
  role, deleteHousehold, deleteRow, deleteUser, loadHousehold, loadOverview, removeMember, resetInviteCode, updateRow,
  type AdminHousehold, type AdminTable,
} from '../admin';
import { formatShort, todayISO } from '../logic/dates';
import { centsToInput, formatCents, parseDollars } from '../logic/money';
import { supabase } from '../supabase';
import { busy, confirmSheet, errorMessage, esc, html, on, sheet, toast } from '../ui/dom';

type Overview = Awaited<ReturnType<typeof loadOverview>>;
interface Me { userId: string; householdId: string | null }

// Support can look but not touch; the database enforces the same split.
const canEdit = () => role === 'admin';

// Kept across re-renders so a partner's realtime change doesn't bounce you back to the list.
let selected: string | null = null;

// Timestamps are UTC; show the calendar day on this device.
const day = (ts: string) => formatShort(todayISO(new Date(ts)));
const when = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Standalone admin page: its own top bar, no household state needed. */
export function adminPage(me: Me): HTMLElement {
  const el = html(`
    <div class="shell" data-admin>
      <header class="top">
        <span class="top-title">${role === 'admin' ? 'Admin' : 'Support'}</span>
        <span class="row-actions">
          ${me.householdId ? '<a href="#/" class="btn ghost sm">Back to app</a>' : ''}
          <button class="btn ghost sm" data-action="signout">Sign out</button>
        </span>
      </header>
      <main id="main"></main>
    </div>`);
  on(el, { signout: () => void supabase.auth.signOut() });
  el.querySelector('#main')!.append(adminView(me));
  return el;
}

function adminView(me: Me): HTMLElement {
  const root = html('<section class="view"><div class="loading">Loading…</div></section>');
  let ov: Overview;
  let hh: AdminHousehold | null = null;
  let loads = 0; // only the newest refresh() may paint, so a slow earlier load can't overwrite it

  const memberName = (id: string | null) =>
    id === null ? 'Shared account' : ov.members.find((m) => m.user_id === id)?.display_name ?? 'Removed member';
  const emailOf = (id: string) => ov.users.find((u) => u.user_id === id)?.email ?? '';
  const householdName = (id: string | null) => ov.households.find((h) => h.id === id)?.name;

  async function refresh() {
    const load = ++loads;
    try {
      const nextOv = await loadOverview();
      const sel = selected && nextOv.households.some((h) => h.id === selected) ? selected : null;
      const nextHh = sel ? await loadHousehold(sel) : null;
      if (load !== loads) return;
      selected = sel;
      ov = nextOv;
      hh = nextHh;
      root.innerHTML = selected && hh ? detail(hh) : overview();
    } catch (err) {
      if (load !== loads) return;
      root.innerHTML = `
        <p class="empty">Couldn't load: ${esc(errorMessage(err))}</p>
        <button class="btn ghost block" data-action="retry">Try again</button>`;
    }
  }

  // Row with Edit amount + Delete buttons, used for bills, payments, deposits and paychecks.
  const row = (table: AdminTable, id: string, name: string, sub: string, cents: number) => `
    <li class="occ">
      <div class="occ-main"><div class="occ-name">${esc(name)}</div><div class="occ-sub">${esc(sub)}</div></div>
      <div class="occ-amt">${esc(formatCents(cents))}</div>
      ${canEdit() ? `
      <button class="icon-btn" data-action="edit" data-table="${table}" data-id="${esc(id)}" aria-label="Edit ${esc(name)}">✎</button>
      <button class="icon-btn" data-action="del" data-table="${table}" data-id="${esc(id)}" aria-label="Delete ${esc(name)}">✕</button>` : ''}
    </li>`;
  const section = (title: string, items: string[], empty: string) => `
    <h2 class="section-title">${title}</h2>
    ${items.length ? `<ul class="list">${items.join('')}</ul>` : `<p class="empty">${empty}</p>`}`;

  function overview(): string {
    return `
      <div class="view-head"><h1>${role === 'admin' ? 'Admin' : 'Support'}</h1></div>
      <p class="muted small">${ov.users.length} users · ${ov.households.length} households</p>

      <div class="card form">
        <label>Find a user <input type="search" data-search placeholder="Email or name" autocomplete="off"></label>
        <ul class="list">${ov.users.map((u) => `
          <li class="occ" data-match="${esc(`${u.email} ${u.display_name ?? ''}`.toLowerCase())}">
            <div class="occ-main">
              <div class="occ-name">${esc(u.email)}${u.user_id === me.userId ? ' <span class="muted">(you)</span>' : ''}</div>
              <div class="occ-sub">${u.display_name ? `${esc(u.display_name)} · ${esc(householdName(u.household_id) ?? '')}` : 'No household'}
                ${u.role ? `· ${esc(u.role)} ` : ''}· last sign-in ${u.last_sign_in_at ? esc(day(u.last_sign_in_at)) : 'never'}</div>
            </div>
            ${u.household_id ? `<button class="btn ghost sm" data-action="open" data-id="${esc(u.household_id)}">Open</button>` : ''}
            ${u.user_id === me.userId || !canEdit() ? '' : `<button class="icon-btn" data-action="del-user" data-id="${esc(u.user_id)}" aria-label="Delete account ${esc(u.email)}">✕</button>`}
          </li>`).join('')}
        </ul>
      </div>

      ${section('Households', ov.households.map((h) => `
        <li class="occ">
          <div class="occ-main">
            <div class="occ-name">${esc(h.name)}</div>
            <div class="occ-sub">${esc(ov.members.filter((m) => m.household_id === h.id).map((m) => m.display_name).join(' & ') || 'No members')}
              · code ${esc(h.invite_code)} · created ${esc(day(h.created_at))}</div>
          </div>
          <button class="btn ghost sm" data-action="open" data-id="${esc(h.id)}">Open</button>
        </li>`), 'No households yet.')}`;
  }

  function detail(d: AdminHousehold): string {
    const h = ov.households.find((x) => x.id === selected)!;
    const members = ov.members.filter((m) => m.household_id === h.id);
    const billName = (id: string) => d.bills.find((b) => b.id === id)?.name ?? 'Deleted bill';
    return `
      <div class="view-head">
        <button class="btn ghost sm" data-action="back">← All households</button>
        <h1>${esc(h.name)}</h1>
      </div>

      <div class="card">
        <div class="invite"><code>${esc(h.invite_code)}</code>
          <button class="btn ghost sm" data-action="reset-code">Reset invite code</button></div>
        <p class="muted small">${h.weekly_mode === 'smoothed' ? 'Smoothed' : 'Pay as due'} · created ${esc(day(h.created_at))}</p>
        ${canEdit() ? '<button class="btn danger-ghost sm" data-action="del-household">Delete household</button>' : ''}
      </div>

      ${section('Members', members.map((m) => `
        <li class="occ">
          <div class="occ-main">
            <div class="occ-name">${esc(m.display_name)}${m.user_id === me.userId ? ' <span class="muted">(you)</span>' : ''}</div>
            <div class="occ-sub">${esc(emailOf(m.user_id))} · ${esc(formatCents(m.pay_amount_cents))} ${esc(m.pay_frequency)}</div>
          </div>
          ${canEdit() ? `<button class="btn ghost sm" data-action="remove-member" data-id="${esc(m.user_id)}">Remove</button>` : ''}
        </li>`), 'No members.')}

      ${section('Bills', d.bills.map((b) => row('bills', b.id, b.name,
        `${b.recurrence} · ${b.owner_id ? `personal (${memberName(b.owner_id)})` : 'shared'}${b.active ? '' : ' · paused'}`, b.amount_cents)), 'No bills.')}
      ${section('Payments', d.payments.map((p) => row('payments', p.id, billName(p.bill_id),
        `due ${formatShort(p.due_date)} · paid ${formatShort(p.paid_on)} by ${memberName(p.paid_by)}`, p.amount_cents)), 'No payments.')}
      ${section('Deposits', d.contributions.map((c) => row('contributions', c.id, memberName(c.member_id),
        `week of ${formatShort(c.week_start)}`, c.amount_cents)), 'No deposits.')}
      ${section('Paychecks', d.paychecks.map((p) => row('paychecks', p.id, memberName(p.member_id),
        `paid ${formatShort(p.paid_on)}`, p.amount_cents)), 'No paychecks.')}

      <h2 class="section-title">Recent activity</h2>
      ${d.activity.length ? `<ul class="list feed">${d.activity.map((a) => `
        <li><div>${esc(a.message)}</div><div class="muted small">${esc(when.format(new Date(a.created_at)))}</div></li>`).join('')}</ul>`
        : '<p class="empty">No activity yet.</p>'}`;
  }

  // Your own household changed underneath the main app: start over from a clean load.
  const touchesMe = (householdId: string | null) => householdId !== null && householdId === me.householdId;
  const restart = () => { location.hash = '#/admin'; location.reload(); };

  function openEdit(table: AdminTable, id: string) {
    const d = hh!;
    const current = (d[table] as { id: string; amount_cents: number }[]).find((r) => r.id === id)!;
    const bill = table === 'bills' ? d.bills.find((b) => b.id === id)! : null;
    const members = ov.members.filter((m) => m.household_id === selected);
    const body = html(`
      <form class="sheet-body form">
        <label>Amount <input name="amount" inputmode="decimal" required value="${esc(centsToInput(current.amount_cents))}"></label>
        ${bill ? `<label>Who pays
          <select name="owner">
            <option value="">Shared (split by income)</option>
            ${members.map((m) => `<option value="${esc(m.user_id)}" ${bill.owner_id === m.user_id ? 'selected' : ''}>${esc(m.display_name)} (personal)</option>`).join('')}
          </select></label>` : ''}
        <button class="btn primary block" type="submit">Save</button>
      </form>`) as HTMLFormElement;
    const sh = sheet('Edit', body);
    body.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(body);
      const amount = parseDollars(String(f.get('amount')));
      if (amount === null) return toast('Enter an amount like 120.50', 'error');
      const patch: Record<string, unknown> = { amount_cents: amount };
      if (bill) patch.owner_id = String(f.get('owner')) || null;
      busy(body.querySelector('button'), async () => {
        await updateRow(table, id, patch);
        sh.close();
        toast('Saved');
        await refresh();
      });
    });
  }

  on(root, {
    open: (b) => { selected = b.dataset.id!; root.innerHTML = '<div class="loading">Loading…</div>'; refresh(); },
    back: () => { selected = null; refresh(); },
    retry: () => { root.innerHTML = '<div class="loading">Loading…</div>'; refresh(); },
    edit: (b) => openEdit(b.dataset.table as AdminTable, b.dataset.id!),
    del: (b) => busy(b, async () => {
      if (!await confirmSheet('Delete?', 'Delete this row for good? This can\'t be undone.', 'Delete', true)) return;
      await deleteRow(b.dataset.table as AdminTable, b.dataset.id!);
      toast('Deleted');
      await refresh();
    }),
    'reset-code': (b) => busy(b, async () => {
      if (!await confirmSheet('Reset invite code?', 'The old code stops working right away.', 'Reset')) return;
      toast(`New code: ${await resetInviteCode(selected!)}`);
      await refresh();
    }),
    'remove-member': (b) => busy(b, async () => {
      const id = b.dataset.id!;
      const deposits = hh!.contributions.filter((c) => c.member_id === id).length;
      const paychecks = hh!.paychecks.filter((p) => p.member_id === id).length;
      const ok = await confirmSheet('Remove member?',
        `Removing ${memberName(id)} also deletes their ${deposits} deposits and ${paychecks} paychecks, and makes their personal bills shared. If they're the last member, the household is deleted too. Their login stays; they can join a household again.`,
        'Remove', true);
      if (!ok) return;
      await removeMember(id);
      if (id === me.userId) return restart();
      toast('Member removed');
      await refresh();
    }),
    'del-user': (b) => busy(b, async () => {
      const u = ov.users.find((x) => x.user_id === b.dataset.id)!;
      const ok = await confirmSheet('Delete account?',
        `Delete ${u.email}? This removes their login and member profile, plus all their deposits and paychecks. If they're the last member of their household, it's deleted too. It can't be undone.`,
        'Delete account', true);
      if (!ok) return;
      await deleteUser(u.user_id);
      toast('Account deleted');
      await refresh();
    }),
    'del-household': (b) => busy(b, async () => {
      const h = ov.households.find((x) => x.id === selected)!;
      const ok = await confirmSheet('Delete household?',
        `Delete ${h.name} with all its bills, payments, deposits, paychecks and activity? Members keep their logins and go back to setup. This can't be undone.`,
        'Delete household', true);
      if (!ok) return;
      await deleteHousehold(h.id);
      if (touchesMe(h.id)) return restart();
      selected = null;
      toast('Household deleted');
      await refresh();
    }),
  });

  // Filter without re-rendering, so the search box keeps focus.
  root.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.matches('[data-search]')) return;
    const q = input.value.trim().toLowerCase();
    root.querySelectorAll<HTMLElement>('[data-match]').forEach((li) => { li.style.display = li.dataset.match!.includes(q) ? '' : 'none'; });
  });

  refresh();
  return root;
}
