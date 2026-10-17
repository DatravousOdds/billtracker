import { formatShort, todayISO } from '../logic/dates';
import { FREQUENCY_LABEL, PER_YEAR } from '../logic/income';
import { formatCents, parseDollars, centsToInput } from '../logic/money';
import type { IncomeMode, PayFrequency } from '../types';
import { addPaycheck, deletePaycheck, getState, shares, updateMember } from '../store';
import { busy, esc, html, on, toast } from '../ui/dom';
import { pct } from '../ui/parts';

const GUIDE = [
  { target: 'mode', title: 'Choose how you’re paid', body: 'Pick <strong>Fixed</strong> if your paycheck is about the same every time. Pick <strong>Log each paycheck</strong> if it changes, like hourly pay, tips or commission.' },
  { target: 'amount', title: 'Enter one paycheck', body: 'Type your take-home pay from <strong>one</strong> paycheck, after taxes, like <strong>1,250.00</strong>. Don’t enter your yearly salary.' },
  { target: 'frequency', title: 'Pick how often you’re paid', body: 'Weekly, every two weeks and so on. The app uses this to work out your monthly income.' },
  { target: 'save', title: 'Tap Save pay', body: 'Your share of the bills updates right away. After that, add your bills on the <a href="#/bills">Bills</a> tab.' },
];
// Per user: partners often share one device.
const guideKey = (userId: string) => `incomeGuideSkipped:${userId}`;
// Lives at module level so realtime re-renders don't send the user back to step 1.
let guideStep = 0;
let guideUser = '';

function guideSkipped(userId: string): boolean {
  try { return localStorage.getItem(guideKey(userId)) === '1'; } catch { return false; }
}
function setGuideSkipped(userId: string, skipped: boolean) {
  try { skipped ? localStorage.setItem(guideKey(userId), '1') : localStorage.removeItem(guideKey(userId)); } catch { /* private mode: guide just reappears */ }
}

export function incomeView(): HTMLElement {
  const s = getState();
  const sh = shares();

  // Same "no income yet" test the dashboard uses, so the two screens agree.
  const needsPay = sh.find((x) => x.member.user_id === s.userId)?.income.monthlyCents === 0;
  if (guideUser !== s.userId) { guideUser = s.userId; guideStep = 0; }
  const showGuide = needsPay && !guideSkipped(s.userId);
  const step = GUIDE[guideStep];
  const win = s.household.income_window_months;

  const cards = sh.map(({ member: m, income, ratio }) => {
    const checks = s.paychecks.filter((p) => p.member_id === m.user_id).slice(0, 8);
    const perPay = m.income_mode === 'per_paycheck';
    const sourceNote = income.source === 'logged'
      ? `Average of ${income.paychecksUsed} paycheck${income.paychecksUsed === 1 ? '' : 's'} over the last ${win} month${win === 1 ? '' : 's'}`
      : income.source === 'fallback'
        ? 'No paychecks logged in the window yet — using usual pay below'
        : `${esc(formatCents(m.pay_amount_cents))} × ${PER_YEAR[m.pay_frequency]} paychecks ÷ 12 months`;
    const hl = (key: string) => showGuide && m.user_id === s.userId && step.target === key ? ' guide-on' : '';

    return `
      <div class="card member" data-member="${esc(m.user_id)}">
        <div class="person-top">
          <h2>${esc(m.display_name)}${m.user_id === s.userId ? ' <span class="muted">(you)</span>' : ''}</h2>
          <span class="person-pct">${pct(ratio)} of bills</span>
        </div>
        <div class="person-amt">${esc(formatCents(Math.round(income.monthlyCents)))}<span class="muted small"> / month</span></div>
        <p class="muted small">${sourceNote}</p>

        <div class="seg full${hl('mode')}" role="group" aria-label="Income mode">
          <button class="${!perPay ? 'on' : ''}" data-action="mode" data-mode="fixed">Fixed</button>
          <button class="${perPay ? 'on' : ''}" data-action="mode" data-mode="per_paycheck">Log each paycheck</button>
        </div>

        <form class="form pay-form" data-form="usual">
          <div class="grid2">
            <label class="${hl('amount')}">${perPay ? 'Usual paycheck (backup)' : 'Paycheck amount'}
              <input name="amount" inputmode="decimal" placeholder="1,250.00" value="${esc(centsToInput(m.pay_amount_cents))}">
            </label>
            <label class="${hl('frequency')}">Paid
              <select name="frequency">
                ${(Object.keys(FREQUENCY_LABEL) as PayFrequency[]).map((f) =>
                  `<option value="${f}" ${m.pay_frequency === f ? 'selected' : ''}>${FREQUENCY_LABEL[f]}</option>`).join('')}
              </select>
            </label>
          </div>
          <button class="btn ghost sm${hl('save')}" type="submit">Save pay</button>
        </form>

        ${perPay ? `
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

  const guide = showGuide ? `
    <div class="card request guide" aria-live="polite">
      <div class="guide-head">
        <span class="muted small">Set up your income · Step ${guideStep + 1} of ${GUIDE.length}</span>
        <button class="btn ghost sm" data-action="guide-skip">Skip guide</button>
      </div>
      <h2 tabindex="-1">${step.title}</h2>
      <p>${step.body}</p>
      <div class="guide-nav">
        ${guideStep > 0 ? '<button class="btn ghost sm" data-action="guide-back">Back</button>' : ''}
        ${guideStep < GUIDE.length - 1
          ? '<button class="btn primary sm" data-action="guide-next">Next</button>'
          : '<button class="btn primary sm" data-action="guide-skip">Got it</button>'}
      </div>
    </div>` : needsPay ? `
    <div class="card request">
      <strong>One last step:</strong> enter your usual paycheck below and tap <em>Save pay</em>. It sets your share of the bills.
      <button class="btn ghost sm" data-action="guide-show">Show me how</button>
    </div>` : '';

  const el = html(`
    <section class="view">
      <div class="view-head">
        <div>
          <h1>Income</h1>
          <p class="muted small">Each of you pays the same percentage of shared bills as your share of combined income.</p>
        </div>
      </div>
      ${guide}
      <div class="stack">${cards}</div>
      ${s.members.length < 2 ? `<p class="empty">Your partner's income shows up here once they join with code <strong>${esc(s.household.invite_code)}</strong>.</p>` : ''}
    </section>`);

  const memberOf = (node: HTMLElement) => node.closest<HTMLElement>('[data-member]')!.dataset.member!;

  const goTo = (i: number) => {
    guideStep = i;
    const next = incomeView();
    // Carry over what the user typed but hasn't saved, or Next would wipe the amount from step 2.
    const key = (f: HTMLInputElement) => `${memberOf(f)}|${f.form?.dataset.form}|${f.name}`;
    const typed = new Map([...el.querySelectorAll<HTMLInputElement>('[data-member] [name]')].map((f) => [key(f), f.value]));
    next.querySelectorAll<HTMLInputElement>('[data-member] [name]').forEach((f) => {
      const v = typed.get(key(f));
      if (v !== undefined) f.value = v;
    });
    el.replaceWith(next);
    // The clicked button is gone; move focus to the new step so keyboard and screen reader users follow along.
    next.querySelector<HTMLElement>('.guide h2, [data-action="guide-show"]')?.focus({ preventScroll: true });
    next.querySelector('.guide-on')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  on(el, {
    'guide-next': () => goTo(guideStep + 1),
    'guide-back': () => goTo(guideStep - 1),
    'guide-skip': () => { setGuideSkipped(s.userId, true); goTo(0); },
    'guide-show': () => { setGuideSkipped(s.userId, false); goTo(0); },
    mode: (b) => busy(b, async () => {
      await updateMember(memberOf(b), { income_mode: b.dataset.mode as IncomeMode });
      toast(b.dataset.mode === 'fixed' ? 'Using fixed income' : 'Now logging each paycheck');
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
