import { formatShort, todayISO } from '../logic/dates';
import { formatCents, parseDollars, centsToInput } from '../logic/money';
import { dueDates, monthlyEquivalent, RECURRENCE_LABEL } from '../logic/recurrence';
import { addDays } from '../logic/dates';
import type { Bill, Recurrence } from '../types';
import {
  deleteBill, getState, memberName, requestOwnership, saveBill, type BillInput,
} from '../store';
import { busy, confirmSheet, esc, html, on, sheet, toast } from '../ui/dom';

const CATEGORIES = ['Housing', 'Utilities', 'Insurance', 'Transportation', 'Phone & Internet', 'Subscriptions', 'Debt', 'Childcare', 'Groceries', 'Medical', 'Other'];

function nextDue(bill: Bill): string | null {
  const today = todayISO();
  return dueDates(bill, today, addDays(today, 400))[0] ?? null;
}

export function billsView(): HTMLElement {
  const s = getState();
  const [active, paused] = [s.bills.filter((b) => b.active), s.bills.filter((b) => !b.active)];
  const shared = active.filter((b) => b.owner_id === null);
  const personal = active.filter((b) => b.owner_id !== null);
  const monthlyShared = shared.reduce((sum, b) => sum + monthlyEquivalent(b), 0);

  const row = (b: Bill) => {
    const next = nextDue(b);
    const pending = s.requests.some((r) => r.bill_id === b.id && r.status === 'pending');
    return `
      <li class="bill-row" data-action="edit" data-id="${esc(b.id)}" tabindex="0" role="button">
        <div class="occ-main">
          <div class="occ-name">${esc(b.name)}
            ${b.autopay ? '<span class="badge">Autopay</span>' : ''}
            ${pending ? '<span class="badge warn">Change pending</span>' : ''}
          </div>
          <div class="occ-sub">${esc(RECURRENCE_LABEL[b.recurrence])} · ${esc(b.category)}${next ? ` · next ${esc(formatShort(next))}` : ' · no upcoming date'}</div>
        </div>
        <div class="occ-amt">${esc(formatCents(b.amount_cents))}</div>
        <span class="chev" aria-hidden="true">›</span>
      </li>`;
  };

  const personalByOwner = s.members
    .map((m) => ({ m, list: personal.filter((b) => b.owner_id === m.user_id) }))
    .filter((g) => g.list.length);

  const el = html(`
    <section class="view">
      <div class="view-head">
        <div>
          <h1>Bills</h1>
          <p class="muted small">Shared bills average ${esc(formatCents(Math.round(monthlyShared)))}/month</p>
        </div>
        <button class="btn primary" data-action="add">+ Add bill</button>
      </div>

      <h2 class="section-title">Shared · split by income</h2>
      ${shared.length ? `<ul class="list">${shared.map(row).join('')}</ul>` : '<p class="empty">No shared bills yet. Add rent, utilities, and so on.</p>'}

      ${personalByOwner.map((g) => `
        <h2 class="section-title">${esc(g.m.display_name)}'s personal bills</h2>
        <ul class="list">${g.list.map(row).join('')}</ul>`).join('')}

      ${paused.length ? `
        <h2 class="section-title muted">Paused</h2>
        <ul class="list dim">${paused.map(row).join('')}</ul>` : ''}
    </section>`);

  on(el, {
    add: () => openBillSheet(null),
    edit: (r) => openBillSheet(s.bills.find((b) => b.id === r.dataset.id) ?? null),
  });
  el.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key === 'Enter' && t.dataset.action === 'edit') t.click();
  });
  return el;
}

function openBillSheet(bill: Bill | null) {
  const s = getState();
  const recurrenceOptions = (Object.keys(RECURRENCE_LABEL) as Recurrence[])
    .map((r) => `<option value="${r}" ${(bill?.recurrence ?? 'monthly') === r ? 'selected' : ''}>${RECURRENCE_LABEL[r]}</option>`)
    .join('');
  const pending = bill ? s.requests.find((r) => r.bill_id === bill.id && r.status === 'pending') : undefined;

  let ownership = '';
  if (bill) {
    if (pending) {
      ownership = `<p class="muted small">A request to make this bill ${pending.kind === 'make_personal' ? `personal (${esc(memberName(pending.owner_id))})` : 'shared'} is waiting for ${pending.requested_by === s.userId ? 'your partner' : 'you — see This week'}.</p>`;
    } else if (bill.owner_id === null) {
      ownership = `
        <p class="muted small">Shared bills are split by income. To make this one personal, your partner has to approve.</p>
        <div class="inline">
          <select name="new_owner" aria-label="Who pays all of it">
            ${s.members.map((m) => `<option value="${esc(m.user_id)}">${esc(m.display_name)} pays all</option>`).join('')}
          </select>
          <button class="btn ghost sm" type="button" data-action="req-personal">Request</button>
        </div>`;
    } else {
      ownership = `
        <p class="muted small">Personal — ${esc(memberName(bill.owner_id))} pays all of it.</p>
        <button class="btn ghost sm" type="button" data-action="req-shared">Request to split it again</button>`;
    }
  }

  const body = html(`
    <form class="sheet-body form">
      <label>Name
        <input name="name" required maxlength="80" value="${esc(bill?.name ?? '')}" placeholder="Rent">
      </label>
      <div class="grid2">
        <label>Amount
          <input name="amount" inputmode="decimal" required value="${bill ? esc(centsToInput(bill.amount_cents)) : ''}" placeholder="0.00">
        </label>
        <label>Repeats
          <select name="recurrence">${recurrenceOptions}</select>
        </label>
      </div>
      <div class="grid2">
        <label>${bill ? 'First due date' : 'Next due date'}
          <input name="start_date" type="date" required value="${esc(bill?.start_date ?? todayISO())}">
        </label>
        <label>Category
          <input name="category" list="categories" value="${esc(bill?.category ?? '')}" placeholder="Other">
          <datalist id="categories">${[...new Set([...CATEGORIES, ...s.bills.map((b) => b.category)])].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
        </label>
      </div>
      <label class="check"><input type="checkbox" name="autopay" ${bill?.autopay ? 'checked' : ''}> Autopay</label>
      ${bill ? `<label class="check"><input type="checkbox" name="active" ${bill.active ? 'checked' : ''}> Active (uncheck to pause)</label>` : ''}

      ${bill ? `<fieldset class="ownership"><legend>Who pays</legend>${ownership}</fieldset>` : '<p class="muted small">New bills start shared. You can ask to make one personal after saving.</p>'}

      <button class="btn primary block" type="submit">${bill ? 'Save changes' : 'Add bill'}</button>
      ${bill ? '<button class="btn danger-ghost block" type="button" data-action="delete">Delete bill</button>' : ''}
    </form>`) as HTMLFormElement;

  const sh = sheet(bill ? 'Edit bill' : 'Add bill', body);

  body.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(body);
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
    busy(body.querySelector('button[type=submit]'), async () => {
      await saveBill(bill?.id ?? null, input);
      sh.close();
      toast(bill ? 'Bill updated' : 'Bill added');
    });
  });

  on(body, {
    delete: (b) => {
      if (!bill) return;
      confirmSheet('Delete bill?', `Delete ${bill.name} and its payment history? Pausing keeps the history.`, 'Delete', true)
        .then((ok) => {
          if (!ok) return;
          busy(b, async () => {
            await deleteBill(bill.id);
            sh.close();
            toast('Bill deleted');
          });
        });
    },
    'req-personal': (b) => {
      if (!bill) return;
      const owner = (body.querySelector('select[name=new_owner]') as HTMLSelectElement).value;
      busy(b, async () => {
        await requestOwnership(bill.id, 'make_personal', owner);
        sh.close();
        toast('Request sent to your partner');
      });
    },
    'req-shared': (b) => {
      if (!bill) return;
      busy(b, async () => {
        await requestOwnership(bill.id, 'make_shared', null);
        sh.close();
        toast('Request sent to your partner');
      });
    },
  });
}
