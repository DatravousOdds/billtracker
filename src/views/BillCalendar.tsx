import { useLayoutEffect, useRef, useState } from 'react';
import { addDays, addMonths, formatLong, toDate, weekStart } from '../logic/dates';
import { occurrences, type Occurrence } from '../logic/split';
import type { Bill, ISODate, Payment } from '../types';
import { OccurrenceRow } from '../ui/parts';

const monthLabel = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const selectedLabel = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeZone: 'UTC' });
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function BillCalendar({ bills, payments, today }: { bills: Bill[]; payments: Payment[]; today: ISODate }) {
  const [selected, setSelected] = useState(today);
  const todayCell = useRef<HTMLButtonElement>(null);
  const focusToday = useRef(false);

  useLayoutEffect(() => {
    if (focusToday.current && selected === today) {
      focusToday.current = false;
      todayCell.current?.focus();
    }
  }, [selected, today]);
  const first = selected.slice(0, 7) + '-01';
  const last = addDays(addMonths(first, 1), -1);
  const byDate = new Map<ISODate, Occurrence[]>();
  for (const occurrence of occurrences(bills, payments, first, last)) {
    const day = byDate.get(occurrence.date) ?? [];
    day.push(occurrence);
    byDate.set(occurrence.date, day);
  }

  const days = Array.from({ length: toDate(first).getUTCDay() + toDate(last).getUTCDate() }, (_, index) =>
    addDays(weekStart(first), index));
  const due = byDate.get(selected) ?? [];

  return (
    <>
      <div className="card bill-calendar">
        <div className="bill-calendar-heading">
          <button type="button" className="btn ghost" aria-label="Previous month" onClick={() => setSelected(addMonths(first, -1))}>‹</button>
          <h2 aria-live="polite">{monthLabel.format(toDate(first))}</h2>
          <button type="button" className="btn ghost" aria-label="Next month" onClick={() => setSelected(addMonths(first, 1))}>›</button>
        </div>
        <div className="bill-calendar-grid" role="group" aria-label="Choose a due date">
          {weekdays.map((day) => <span className="muted" key={day} aria-hidden="true">{day}</span>)}
          {days.map((date) => {
            if (date < first) return <span key={date} aria-hidden="true" />;
            const count = byDate.get(date)?.length ?? 0;
            return (
              <button key={date} type="button" className="bill-calendar-day" aria-pressed={date === selected}
                ref={date === today ? todayCell : undefined}
                aria-current={date === today ? 'date' : undefined}
                aria-label={`${formatLong(date)}, ${count} ${count === 1 ? 'bill' : 'bills'} due`}
                onClick={() => setSelected(date)}>
                <span>{toDate(date).getUTCDate()}</span>
                {count > 0 && <span className="bill-calendar-count" aria-hidden="true">{count}</span>}
              </button>
            );
          })}
        </div>
        {selected !== today && (
          <button type="button" className="btn ghost" onClick={() => {
            focusToday.current = true;
            setSelected(today);
          }}>Today</button>
        )}
      </div>
      <h2 className="section-title" aria-live="polite">{selectedLabel.format(toDate(selected))}</h2>
      {due.length ? (
        <ul className="list">
          {due.map((occurrence) => <OccurrenceRow key={`${occurrence.bill.id}|${occurrence.date}`} o={occurrence} today={today} />)}
        </ul>
      ) : <p className="empty">No bills due this day.</p>}
    </>
  );
}
