// Shared UI pieces used by several screens.
import { formatLong, todayISO } from '../logic/dates';
import { formatCents, parseDollars, centsToInput } from '../logic/money';
import type { Occurrence } from '../logic/split';
import { getState, markPaid, memberName, unmarkPaid } from '../store';
import { $, busy, esc, html, sheet, toast } from './dom';

export function billBadges(o: Occurrence): string {
  const s = getState();
  const badges: string[] = [];
  if (o.bill.owner_id) {
    badges.push(`<span class="badge personal">${esc(memberName(o.bill.owner_id))}'s</span>`);
  }
  if (o.bill.autopay) badges.push('<span class="badge">Autopay</span>');
  const pending = s.requests.find((r) => r.bill_id === o.bill.id && r.status === 'pending');
  if (pending) badges.push('<span class="badge warn">Change pending</span>');
  return badges.join('');
}

/** One bill due date as a list row with a paid toggle. */
export function occurrenceRow(o: Occurrence, today = todayISO()): string {
  const overdue = !o.payment && !o.bill.autopay && o.date < today && o.date >= o.bill.created_at.slice(0, 10);
  const status = o.payment
    ? `<button class="pill paid" data-action="unpay" data-payment="${esc(o.payment.id)}" aria-label="Paid. Tap to undo">✓ Paid</button>`
    : `<button class="pill ${overdue ? 'overdue' : ''}" data-action="pay" data-bill="${esc(o.bill.id)}" data-date="${esc(o.date)}">Confirm paid</button>`;
  const paidNote = o.payment
    ? `<span class="muted"> · ${esc(formatCents(o.payment.amount_cents))} by ${esc(memberName(o.payment.paid_by))}</span>`
    : '';
  return `
    <li class="occ ${overdue ? 'is-overdue' : ''} ${o.payment ? 'is-paid' : ''}">
      <div class="occ-main">
        <div class="occ-name">${esc(o.bill.name)} ${billBadges(o)}</div>
        <div class="occ-sub">${overdue ? '<strong>Overdue</strong> · ' : ''}${esc(formatLong(o.date))}${paidNote}</div>
      </div>
      <div class="occ-amt">${esc(formatCents(o.bill.amount_cents))}</div>
      ${status}
    </li>`;
}

/** Handlers for the pay / unpay buttons rendered by occurrenceRow. */
export const occurrenceHandlers = {
  pay: (el: HTMLElement) => openPaySheet(el.dataset.bill!, el.dataset.date!),
  unpay: (el: HTMLElement) => busy(el, async () => {
    await unmarkPaid(el.dataset.payment!);
    toast('Marked as not paid');
  }),
};

function openPaySheet(billId: string, dueDate: string) {
  const s = getState();
  const bill = s.bills.find((b) => b.id === billId);
  if (!bill) return;
  const defaultPayer = bill.owner_id ?? (s.household.weekly_mode === 'smoothed' ? '' : s.userId);
  const options = [
    `<option value="">Shared bill account</option>`,
    ...s.members.map((m) => `<option value="${esc(m.user_id)}">${esc(m.display_name)}</option>`),
  ].join('');
  const body = html(`
    <form class="sheet-body form">
      <p class="muted">${esc(bill.name)} · due ${esc(formatLong(dueDate))}</p>
      <label>Amount paid
        <input name="amount" inputmode="decimal" required value="${esc(centsToInput(bill.amount_cents))}">
      </label>
      <label>Paid from
        <select name="paid_by">${options}</select>
      </label>
      <label>Paid on
        <input name="paid_on" type="date" required value="${esc(todayISO())}">
      </label>
      <button class="btn primary block" type="submit">Yes, it's paid</button>
    </form>`) as HTMLFormElement;
  ($(body, 'select[name=paid_by]') as HTMLSelectElement).value = defaultPayer;
  const sh = sheet('Confirm payment', body);
  body.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(body);
    const amount = parseDollars(String(f.get('amount')));
    if (amount === null) return toast('Enter an amount like 120.50', 'error');
    busy(body.querySelector('button[type=submit]'), async () => {
      await markPaid(bill, dueDate, amount, (f.get('paid_by') as string) || null, String(f.get('paid_on')));
      sh.close();
      toast(`${bill.name} confirmed paid`);
    });
  });
}

export function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1).replace(/\.0$/, '')}%`;
}
