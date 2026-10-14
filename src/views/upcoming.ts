import { addDays, formatShort, todayISO, weekStart } from '../logic/dates';
import { formatCents } from '../logic/money';
import { occurrences, type Occurrence } from '../logic/split';
import { getState } from '../store';
import { esc, html, on } from '../ui/dom';
import { occurrenceHandlers, occurrenceRow } from '../ui/parts';

let rangeDays = 60; // remembered while the app is open

export function upcomingView(days = rangeDays): HTMLElement {
  rangeDays = days;
  const s = getState();
  const today = todayISO();
  const list = occurrences(s.bills, s.payments, today, addDays(today, days));

  const weeks = new Map<string, Occurrence[]>();
  for (const o of list) {
    const w = weekStart(o.date);
    if (!weeks.has(w)) weeks.set(w, []);
    weeks.get(w)!.push(o);
  }

  const total = (items: Occurrence[], shared: boolean) =>
    items.filter((o) => (o.bill.owner_id === null) === shared).reduce((sum, o) => sum + o.bill.amount_cents, 0);

  const groups = [...weeks.entries()].map(([w, items]) => {
    const personal = total(items, false);
    return `
      <div class="week-group">
        <div class="week-head">
          <span>Week of ${esc(formatShort(w))}</span>
          <span class="muted small">${esc(formatCents(total(items, true)))} shared${personal ? ` · ${esc(formatCents(personal))} personal` : ''}</span>
        </div>
        <ul class="list">${items.map((o) => occurrenceRow(o, today)).join('')}</ul>
      </div>`;
  }).join('');

  const el = html(`
    <section class="view">
      <div class="view-head">
        <div>
          <h1>Upcoming</h1>
          <p class="muted small">Next ${days} days</p>
        </div>
        <div class="seg" role="group" aria-label="Range">
          <button class="${days === 30 ? 'on' : ''}" data-action="range" data-days="30">30d</button>
          <button class="${days === 60 ? 'on' : ''}" data-action="range" data-days="60">60d</button>
          <button class="${days === 90 ? 'on' : ''}" data-action="range" data-days="90">90d</button>
        </div>
      </div>
      ${groups || '<p class="empty">No bills coming up. Add some on the Bills tab.</p>'}
    </section>`);

  on(el, {
    ...occurrenceHandlers,
    range: (b) => el.replaceWith(upcomingView(Number(b.dataset.days))),
  });
  return el;
}
