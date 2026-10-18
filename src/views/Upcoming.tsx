import { useState } from 'react';
import { addDays, formatShort, todayISO, weekStart } from '../logic/dates';
import { formatCents } from '../logic/money';
import { occurrences, type Occurrence } from '../logic/split';
import { useAppState } from '../ui/hooks';
import { OccurrenceRow } from '../ui/parts';

let rememberedDays = 60; // remembered while the app is open

export function UpcomingView() {
  const s = useAppState();
  const [days, setDays] = useState(rememberedDays);
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

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h1>Upcoming</h1>
          <p className="muted small">Next {days} days</p>
        </div>
        <div className="seg" role="group" aria-label="Range">
          {[30, 60, 90].map((d) => (
            <button key={d} type="button" className={days === d ? 'on' : ''} onClick={() => setDays(rememberedDays = d)}>{d}d</button>
          ))}
        </div>
      </div>
      {weeks.size ? [...weeks.entries()].map(([w, items]) => {
        const personal = total(items, false);
        return (
          <div className="week-group" key={w}>
            <div className="week-head">
              <span>Week of {formatShort(w)}</span>
              <span className="muted small">{formatCents(total(items, true))} shared{personal ? ` · ${formatCents(personal)} personal` : ''}</span>
            </div>
            <ul className="list">{items.map((o) => <OccurrenceRow key={`${o.bill.id}|${o.date}`} o={o} today={today} />)}</ul>
          </div>
        );
      }) : <p className="empty">No bills coming up. Add some on the Bills tab.</p>}
    </section>
  );
}
