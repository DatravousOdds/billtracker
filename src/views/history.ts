import { formatShort } from '../logic/dates';
import { formatCents } from '../logic/money';
import { ledger } from '../logic/split';
import { deleteContribution, getState, memberName, shares, unmarkPaid } from '../store';
import { busy, esc, html, on, toast } from '../ui/dom';
import { pct } from '../ui/parts';

type Tab = 'payments' | 'deposits' | 'activity';
let currentTab: Tab = 'payments';

const when = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function historyView(): HTMLElement {
  const s = getState();
  const led = ledger(s.bills, s.payments, s.contributions, shares());
  const billName = (id: string) => s.bills.find((b) => b.id === id)?.name ?? 'Deleted bill';

  const payments = [...s.payments].sort((a, b) => b.paid_on.localeCompare(a.paid_on) || b.due_date.localeCompare(a.due_date));

  const tabBody: Record<Tab, () => string> = {
    payments: () => payments.length ? `
      <ul class="list">${payments.map((p) => `
        <li class="occ">
          <div class="occ-main">
            <div class="occ-name">${esc(billName(p.bill_id))}</div>
            <div class="occ-sub">Paid ${esc(formatShort(p.paid_on))} by ${esc(memberName(p.paid_by))} · due ${esc(formatShort(p.due_date))}</div>
          </div>
          <div class="occ-amt">${esc(formatCents(p.amount_cents))}</div>
          <button class="icon-btn" data-action="del-payment" data-id="${esc(p.id)}" aria-label="Undo payment">↺</button>
        </li>`).join('')}</ul>` : '<p class="empty">No payments yet.</p>',

    deposits: () => s.contributions.length ? `
      <ul class="list">${s.contributions.map((c) => `
        <li class="occ">
          <div class="occ-main">
            <div class="occ-name">${esc(memberName(c.member_id))}</div>
            <div class="occ-sub">Week of ${esc(formatShort(c.week_start))}</div>
          </div>
          <div class="occ-amt">${esc(formatCents(c.amount_cents))}</div>
          ${c.member_id === s.userId ? `<button class="icon-btn" data-action="del-deposit" data-id="${esc(c.id)}" aria-label="Remove deposit">✕</button>` : ''}
        </li>`).join('')}</ul>` : '<p class="empty">No deposits yet. Confirm yours from This week.</p>',

    activity: () => s.activity.length ? `
      <ul class="list feed">${s.activity.map((a) => `
        <li><div>${esc(a.message)}</div><div class="muted small">${esc(when.format(new Date(a.created_at)))}</div></li>`).join('')}
      </ul>` : '<p class="empty">No activity yet.</p>',
  };

  const el = html(`
    <section class="view">
      <div class="view-head"><h1>History</h1></div>

      <div class="card">
        <div class="eyebrow">Running balance</div>
        <table class="ledger">
          <thead><tr><th></th><th>Put in</th><th>Fair share</th><th>Balance</th></tr></thead>
          <tbody>${led.balances.map((b) => `
            <tr>
              <th>${esc(b.member.display_name)} <span class="muted small">${pct(shares().find((x) => x.member.user_id === b.member.user_id)?.ratio ?? 0)}</span></th>
              <td>${esc(formatCents(b.putInCents))}</td>
              <td>${esc(formatCents(b.fairShareCents))}</td>
              <td class="${b.balanceCents > 0 ? 'pos' : b.balanceCents < 0 ? 'neg' : ''}">${b.balanceCents > 0 ? '+' : ''}${esc(formatCents(b.balanceCents))}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        <p class="muted small">"Put in" = bill-account deposits + shared bills paid directly. Fair share uses today's income split. Bill account holds ${esc(formatCents(led.accountCents))}.</p>
      </div>

      <div class="seg full" role="tablist">
        ${(['payments', 'deposits', 'activity'] as Tab[]).map((t) =>
          `<button role="tab" class="${currentTab === t ? 'on' : ''}" data-action="tab" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
      </div>
      <div class="tab-body">${tabBody[currentTab]()}</div>
    </section>`);

  on(el, {
    tab: (b) => {
      currentTab = b.dataset.tab as Tab;
      el.replaceWith(historyView());
    },
    'del-payment': (b) => busy(b, async () => {
      await unmarkPaid(b.dataset.id!);
      toast('Payment removed');
    }),
    'del-deposit': (b) => busy(b, async () => {
      await deleteContribution(b.dataset.id!);
      toast('Deposit removed');
    }),
  });
  return el;
}
