import { addDays, addMonths, formatShort, todayISO, toDate } from '../logic/dates';
import { formatCents, parseDollars, centsToInput } from '../logic/money';
import { ledger, leftover, needsConfirming, weekPlan, type Leftover } from '../logic/split';
import { addContribution, decideRequest, getState, memberName, shares } from '../store';
import { busy, esc, html, on, sheet, toast } from '../ui/dom';
import { occurrenceHandlers, occurrenceRow, pct } from '../ui/parts';

export function dashboardView(): HTMLElement {
  const s = getState();
  const today = todayISO();
  const sh = shares();
  const plan = weekPlan(today, s.household.weekly_mode, s.bills, s.payments, sh);
  // Bills that came due and nobody has confirmed paying yet. Shown first, and left out
  // of "Due this week" below so they don't appear twice.
  const toConfirm = needsConfirming(s.bills, s.payments, today);
  const key = (o: { bill: { id: string }; date: string }) => `${o.bill.id}|${o.date}`;
  const confirmKeys = new Set(toConfirm.map(key));
  const restThisWeek = plan.dueThisWeek.filter((o) => !confirmKeys.has(key(o)));
  const led = ledger(s.bills, s.payments, s.contributions, sh);
  const smoothed = plan.mode === 'smoothed';

  // ----- Requests -----
  const pending = s.requests.filter((r) => r.status === 'pending');
  const requestCards = pending.map((r) => {
    const bill = s.bills.find((b) => b.id === r.bill_id);
    const what = r.kind === 'make_personal'
      ? `make <strong>${esc(bill?.name)}</strong> personal — ${esc(memberName(r.owner_id))} pays all of it`
      : `make <strong>${esc(bill?.name)}</strong> shared again — split by income`;
    if (r.requested_by === s.userId) {
      return `
        <div class="card request mine">
          <p>You asked to ${what}. Waiting for your partner.</p>
          <button class="btn ghost sm" data-action="decide" data-id="${esc(r.id)}" data-decision="cancelled">Cancel request</button>
        </div>`;
    }
    return `
      <div class="card request">
        <p><strong>${esc(memberName(r.requested_by))}</strong> wants to ${what}.</p>
        <div class="row-actions">
          <button class="btn ghost sm" data-action="decide" data-id="${esc(r.id)}" data-decision="declined">Decline</button>
          <button class="btn primary sm" data-action="decide" data-id="${esc(r.id)}" data-decision="approved">Approve</button>
        </div>
      </div>`;
  }).join('');

  // ----- Who pays what -----
  const deposited = (memberId: string) => s.contributions
    .filter((c) => c.member_id === memberId && c.week_start === plan.weekStart)
    .reduce((sum, c) => sum + c.amount_cents, 0);

  const people = plan.perMember.map((p) => {
    const done = deposited(p.member.user_id);
    const isMe = p.member.user_id === s.userId;
    // contributions are sorted newest first, so the first match is the partner's latest.
    const last = !isMe && smoothed ? s.contributions.find((c) => c.member_id === p.member.user_id) : undefined;
    // Only you can confirm your own deposit; your partner's card just shows their status.
    const action = !smoothed ? ''
      : done >= p.sharedCents && p.sharedCents > 0 ? `<span class="pill paid">✓ Deposited</span>`
      : isMe ? `<button class="pill" data-action="deposit" data-amount="${p.sharedCents - done}">${done > 0 ? 'Confirm the rest' : 'Confirm my deposit'}</button>`
      : `<span class="muted small">${done > 0 ? 'Partly deposited' : 'Not deposited yet'}</span>`;
    return `
      <div class="person">
        <div class="person-top">
          <span class="person-name">${esc(p.member.display_name)}${p.member.user_id === s.userId ? ' <span class="muted">(you)</span>' : ''}</span>
          <span class="person-pct">${pct(p.ratio)}</span>
        </div>
        <div class="person-amt">${esc(formatCents(p.sharedCents))}</div>
        ${p.personalCents ? `<div class="muted small">+ ${esc(formatCents(p.personalCents))} personal bills this week</div>` : ''}
        ${done > 0 && done < p.sharedCents ? `<div class="muted small">${esc(formatCents(done))} deposited so far</div>` : ''}
        ${action}
        ${last ? `<div class="muted small">Last deposit: ${esc(formatCents(last.amount_cents))} · week of ${esc(formatShort(last.week_start))}</div>` : ''}
      </div>`;
  }).join('');

  const breakdown = smoothed
    ? `${esc(formatCents(plan.regularCents))} weekly average of shared bills${plan.oneTimeCents ? ` + ${esc(formatCents(plan.oneTimeCents))} one-time bills due this week` : ''}`
    : `Shared bills due this week`;

  const noIncome = sh.every((x) => x.income.monthlyCents === 0);
  const onlyOne = s.members.length < 2;

  // ----- Left after bills -----
  const monthStart = today.slice(0, 8) + '01';
  const weekLeft = leftover(s.bills, s.payments, sh, plan.weekStart, plan.weekEnd, 'week');
  const monthLeft = leftover(s.bills, s.payments, sh, monthStart, addDays(addMonths(monthStart, 1), -1), 'month');
  const monthName = toDate(monthStart).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const leftRow = (label: string, l: Leftover) => `
    <div class="muted small">${label}</div>
    <div class="person-amt${l.leftCents < 0 ? ' danger-text' : ''}">${esc(formatCents(l.leftCents))}</div>
    <div class="muted small">${esc(formatCents(l.incomeCents))} income − ${esc(formatCents(l.sharedCents))} shared${l.personalCents ? ` − ${esc(formatCents(l.personalCents))} personal` : ''}</div>`;
  const leftPeople = weekLeft.map((w, i) => `
    <div class="person">
      <span class="person-name">${esc(w.member.display_name)}${w.member.user_id === s.userId ? ' <span class="muted">(you)</span>' : ''}</span>
      ${leftRow('This week', w)}
      ${leftRow(`This month · ${monthName}`, monthLeft[i])}
    </div>`).join('');

  // ----- Balance -----
  const ahead = led.balances.find((b) => b.balanceCents > 0);
  const balanceLine = ahead && s.members.length === 2
    ? `${esc(ahead.member.display_name)} has covered <strong>${esc(formatCents(ahead.balanceCents))}</strong> more than their share`
    : `You're both even`;

  const el = html(`
    <section class="view">
      ${requestCards ? `<div class="stack">${requestCards}</div>` : ''}
      ${toConfirm.length ? `
        <div class="card remind">
          <div class="remind-head">
            <span class="remind-icon" aria-hidden="true">🔔</span>
            <div>
              <strong>Did you pay ${toConfirm.length === 1 ? 'this bill' : `these ${toConfirm.length} bills`}?</strong>
              <div class="muted small">${toConfirm.length === 1 ? "It's due. Confirm it once it's paid." : "They're due. Confirm each one once it's paid."}</div>
            </div>
          </div>
          <ul class="list">${toConfirm.map((o) => occurrenceRow(o, today)).join('')}</ul>
        </div>` : ''}
      ${onlyOne ? `<div class="card note">Your partner hasn't joined yet. Share invite code <strong>${esc(s.household.invite_code)}</strong> (also in Settings).</div>` : ''}
      ${noIncome ? `<div class="card note">Add income on the <a href="#/income">Income</a> tab so the split reflects what each of you earns. Until then it's 50/50.</div>` : ''}

      <div class="card hero">
        <div class="hero-head">
          <div>
            <div class="eyebrow">This week · ${esc(formatShort(plan.weekStart))} – ${esc(formatShort(plan.weekEnd))}</div>
            <div class="hero-total">${esc(formatCents(plan.sharedTotalCents))}</div>
            <div class="muted small">${breakdown}</div>
          </div>
          <span class="mode-tag">${smoothed ? 'Smoothed' : 'Pay as due'}</span>
        </div>
        <div class="people">${people}</div>
      </div>

      <div class="card">
        <div class="eyebrow">Left after bills</div>
        <div class="muted small">Income minus the bills due in each period, paid or not.${smoothed ? ' Uses bills actually due, not the smoothed weekly amount.' : ''}</div>
        <div class="people">${leftPeople}</div>
      </div>

      <h2 class="section-title">Due this week</h2>
      ${restThisWeek.length
        ? `<ul class="list">${restThisWeek.map((o) => occurrenceRow(o, today)).join('')}</ul>`
        : `<p class="empty">${toConfirm.length ? 'Nothing else' : 'Nothing'} due this week.</p>`}

      <a class="card balance" href="#/history">
        <div>
          <div class="eyebrow">Running balance</div>
          <div>${balanceLine}</div>
          ${smoothed ? `<div class="muted small">Bill account: ${esc(formatCents(led.accountCents))} (deposits minus bills paid from it)</div>` : ''}
        </div>
        <span aria-hidden="true">›</span>
      </a>
    </section>`);

  on(el, {
    ...occurrenceHandlers,
    decide: (b) => busy(b, async () => {
      await decideRequest(b.dataset.id!, b.dataset.decision as 'approved' | 'declined' | 'cancelled');
      toast(b.dataset.decision === 'approved' ? 'Approved' : b.dataset.decision === 'declined' ? 'Declined' : 'Request cancelled');
    }),
    deposit: (b) => openDepositSheet(Number(b.dataset.amount), plan.weekStart),
  });
  return el;
}

function openDepositSheet(amountCents: number, weekStart: string) {
  const body = html(`
    <form class="sheet-body form">
      <p class="muted">Your deposit · week of ${esc(formatShort(weekStart))}</p>
      <label>Amount you deposited
        <input name="amount" inputmode="decimal" required value="${esc(centsToInput(Math.max(amountCents, 0)))}">
      </label>
      <button class="btn primary block" type="submit">Yes, I deposited this</button>
    </form>`) as HTMLFormElement;
  const sh = sheet('Confirm your deposit', body);
  body.addEventListener('submit', (e) => {
    e.preventDefault();
    const amount = parseDollars(String(new FormData(body).get('amount')));
    if (amount === null) return toast('Enter an amount like 120.50', 'error');
    busy(body.querySelector('button'), async () => {
      await addContribution(weekStart, amount);
      sh.close();
      toast('Deposit saved');
    });
  });
}
