import { formatShort, todayISO } from '../logic/dates';
import { FREQUENCY_LABEL, PER_YEAR, paychecksNeeded } from '../logic/income';
import { formatCents, parseDollars, centsToInput } from '../logic/money';
import type { IncomeMode, PayFrequency, PaycheckAverage } from '../types';
import { addPaycheck, deletePaycheck, getState, shares, updateMember } from '../store';
import { busy, esc, html, on, toast } from '../ui/dom';
import { pct } from '../ui/parts';

export function incomeView(): HTMLElement {
  const s = getState();
  const sh = shares();

  const cards = sh.map(({ member: m, income, ratio }) => {
    const checks = s.paychecks.filter((p) => p.member_id === m.user_id).slice(0, 8);
    const perPay = m.income_mode === 'per_paycheck';
    const auto = m.paycheck_average !== 'per_paycheck';
    const n = paychecksNeeded(m.pay_frequency);
    const latest = `latest ${n === 1 ? 'paycheck' : `${n} paychecks`}`;
    const sourceNote = income.source === 'auto'
      ? `Your ${latest} added up (one month's worth when paid ${FREQUENCY_LABEL[m.pay_frequency].toLowerCase()})`
      : income.source === 'per_paycheck'
        ? `Average of your ${latest} × ${PER_YEAR[m.pay_frequency]} paychecks ÷ 12 months`
        : income.source === 'fallback'
          ? `Log ${n} paycheck${n === 1 ? '' : 's'} to use your average (${income.paychecksUsed} so far) — using usual pay below`
          : `${esc(formatCents(m.pay_amount_cents))} × ${PER_YEAR[m.pay_frequency]} paychecks ÷ 12 months`;

    return `
      <div class="card member" data-member="${esc(m.user_id)}">
        <div class="person-top">
          <h2>${esc(m.display_name)}${m.user_id === s.userId ? ' <span class="muted">(you)</span>' : ''}</h2>
          <span class="person-pct">${pct(ratio)} of bills</span>
        </div>
        <div class="person-amt">${esc(formatCents(Math.round(income.monthlyCents)))}<span class="muted small"> / month</span></div>
        <p class="muted small">${sourceNote}</p>

        <div class="seg full" role="group" aria-label="Income mode">
          <button class="${!perPay ? 'on' : ''}" data-action="mode" data-mode="fixed">Fixed</button>
          <button class="${perPay ? 'on' : ''}" data-action="mode" data-mode="per_paycheck">Log each paycheck</button>
        </div>

        <form class="form pay-form" data-form="usual">
          <div class="grid2">
            <label>${perPay ? 'Usual paycheck (backup)' : 'Paycheck amount'}
              <input name="amount" inputmode="decimal" value="${esc(centsToInput(m.pay_amount_cents))}">
            </label>
            <label>Paid
              <select name="frequency">
                ${(Object.keys(FREQUENCY_LABEL) as PayFrequency[]).map((f) =>
                  `<option value="${f}" ${m.pay_frequency === f ? 'selected' : ''}>${FREQUENCY_LABEL[f]}</option>`).join('')}
              </select>
            </label>
          </div>
          <button class="btn ghost sm" type="submit">Save pay</button>
        </form>

        ${perPay ? `
          <p class="small">How do you want to calculate the average?</p>
          <div class="seg full" role="group" aria-label="How to calculate the average">
            <button class="${auto ? 'on' : ''}" data-action="avg" data-avg="auto">Automatic</button>
            <button class="${!auto ? 'on' : ''}" data-action="avg" data-avg="per_paycheck">By paycheck</button>
          </div>
          <form class="form pay-form" data-form="check">
            <div class="grid2">
              <label>Paycheck amount
                <input name="amount" inputmode="decimal" required placeholder="0.00">
              </label>
              <label>Date
                <input name="paid_on" type="date" required value="${esc(todayISO())}">
              </label>
            </div>
            <button class="btn primary sm" type="submit">Log paycheck</button>
          </form>
          ${checks.length ? `
            <ul class="list compact">
              ${checks.map((p) => `
                <li class="occ">
                  <div class="occ-main"><div class="occ-sub">${esc(formatShort(p.paid_on))}</div></div>
                  <div class="occ-amt">${esc(formatCents(p.amount_cents))}</div>
                  <button class="icon-btn" data-action="del-check" data-id="${esc(p.id)}" aria-label="Remove paycheck">✕</button>
                </li>`).join('')}
            </ul>` : ''}` : ''}
      </div>`;
  }).join('');

  const el = html(`
    <section class="view">
      <div class="view-head">
        <div>
          <h1>Income</h1>
          <p class="muted small">Each of you pays the same percentage of shared bills as your share of combined income.</p>
        </div>
      </div>
      <div class="stack">${cards}</div>
      ${s.members.length < 2 ? `<p class="empty">Your partner's income shows up here once they join with code <strong>${esc(s.household.invite_code)}</strong>.</p>` : ''}
    </section>`);

  const memberOf = (node: HTMLElement) => node.closest<HTMLElement>('[data-member]')!.dataset.member!;

  on(el, {
    mode: (b) => busy(b, async () => {
      await updateMember(memberOf(b), { income_mode: b.dataset.mode as IncomeMode });
      toast(b.dataset.mode === 'fixed' ? 'Using fixed income' : 'Now logging each paycheck');
    }),
    avg: (b) => busy(b, async () => {
      await updateMember(memberOf(b), { paycheck_average: b.dataset.avg as PaycheckAverage });
      toast(b.dataset.avg === 'auto' ? 'Averaging automatically' : 'Averaging by paycheck');
    }),
    'del-check': (b) => busy(b, async () => {
      await deletePaycheck(b.dataset.id!);
      toast('Paycheck removed');
    }),
  });

  el.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const f = new FormData(form);
    const memberId = memberOf(form);
    const amount = parseDollars(String(f.get('amount')));
    if (amount === null) return toast('Enter an amount like 1,250.00', 'error');
    const btn = form.querySelector('button[type=submit]') as HTMLElement;
    if (form.dataset.form === 'usual') {
      busy(btn, async () => {
        await updateMember(memberId, { pay_amount_cents: amount, pay_frequency: f.get('frequency') as PayFrequency });
        toast('Pay saved');
      });
    } else {
      busy(btn, async () => {
        await addPaycheck(memberId, amount, String(f.get('paid_on')));
        toast('Paycheck logged');
      });
    }
  });
  return el;
}
