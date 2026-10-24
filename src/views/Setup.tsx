import { useEffect, useRef, useState, type FormEvent } from 'react';
import { addDays, formatShort, todayISO } from '../logic/dates';
import { FREQUENCY_LABEL, paydays } from '../logic/income';
import { centsToInput, parseDollars } from '../logic/money';
import { updateMember } from '../store';
import type { ISODate, PayFrequency } from '../types';
import { useAppState, useBusy } from '../ui/hooks';
import { toast } from '../ui/toast';

const QUESTIONS = 3;

/** First-run pay setup: one plain question per screen, then a short "how it works". */
export function SetupView() {
  const s = useAppState();
  const me = s.members.find((m) => m.user_id === s.userId)!;
  const savedPayday = paydays(me, todayISO(), addDays(todayISO(), 62))[0] ?? null;
  const [step, setStep] = useState(0);
  const [amount, setAmount] = useState(me.pay_amount_cents ? centsToInput(me.pay_amount_cents) : '');
  const [frequency, setFrequency] = useState<PayFrequency>(me.pay_frequency);
  const [payday, setPayday] = useState<ISODate>(savedPayday ?? '');
  const [busy, run] = useBusy();
  const heading = useRef<HTMLHeadingElement>(null);

  // Each step swaps the whole screen; move focus to its question so screen readers follow along.
  // (Not on the first screen, where the amount field takes focus.)
  useEffect(() => { if (step > 0) heading.current?.focus(); }, [step]);

  const saveAmount = (e: FormEvent) => {
    e.preventDefault();
    if (parseDollars(amount) === null) return toast('Enter an amount like 1,250.00', 'error');
    setStep(1);
  };

  const save = (next: ISODate | null) => run(async () => {
    await updateMember(me.user_id, {
      pay_amount_cents: parseDollars(amount)!, pay_frequency: frequency,
      // Only send payday when it changed, so this keeps working before pay-schedule.sql has run.
      ...(next !== savedPayday && { payday: next }),
    });
    setPayday(next ?? '');
    setStep(3);
  });

  const back = step > 0 && step < QUESTIONS && <button type="button" className="btn ghost block" onClick={() => setStep(step - 1)}>Back</button>;

  return (
    <section className="auth setup">
      {step < QUESTIONS && (
        <div className="setup-top">
          <span className="muted small">Step {step + 1} of {QUESTIONS}</span>
          <a href="#/" className="muted small">Skip for now</a>
        </div>
      )}
      {step < QUESTIONS && <progress value={step + 1} max={QUESTIONS} aria-label="Setup progress" />}

      {step === 0 && (
        <form className="form" onSubmit={saveAmount}>
          <h1 ref={heading} tabIndex={-1}>How much is one paycheck?</h1>
          <p className="muted">Your take-home pay from one paycheck, after taxes. If it changes, use a typical amount.</p>
          <label>Paycheck amount
            <input inputMode="decimal" placeholder="1,250.00" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          </label>
          <button className="btn primary block" type="submit">Continue</button>
        </form>
      )}

      {step === 1 && (
        <div className="form">
          <h1 ref={heading} tabIndex={-1}>How often are you paid?</h1>
          <div className="choices" role="group" aria-label="How often are you paid">
            {(Object.keys(FREQUENCY_LABEL) as PayFrequency[]).map((f) => (
              <button key={f} type="button" className={`btn block${f === frequency ? ' primary' : ''}`} aria-pressed={f === frequency}
                onClick={() => { setFrequency(f); setStep(2); }}>{FREQUENCY_LABEL[f]}</button>
            ))}
          </div>
          {back}
        </div>
      )}

      {step === 2 && (
        <form className="form" onSubmit={(e) => { e.preventDefault(); save(payday || null); }}>
          <h1 ref={heading} tabIndex={-1}>When is your next payday?</h1>
          <p className="muted">You'll only be asked to put money in on the weeks you get paid.</p>
          <label>Next payday
            <input type="date" required min={todayISO()} max={addDays(todayISO(), 364)} value={payday} onChange={(e) => setPayday(e.target.value)} />
          </label>
          <button className="btn primary block" type="submit" disabled={busy}>Continue</button>
          <button type="button" className="btn ghost block" disabled={busy} onClick={() => save(null)}>I don't have a set payday</button>
          {back}
        </form>
      )}

      {step === 3 && (
        <div className="form">
          <h1 ref={heading} tabIndex={-1}>You're all set</h1>
          <div className="card stack">
            <p>Each of you pays a share of the bills that matches what you earn.</p>
            {payday
              ? <p>On weeks you get paid, put in enough to cover the bills until your next paycheck. Other weeks, nothing is due. Your next payday is <strong>{formatShort(payday)}</strong>.</p>
              : <p>Each week, put in your share of that week's bills.</p>}
            <p className="muted small">You can change any of this later on the Income tab.</p>
          </div>
          <button type="button" className="btn primary block" onClick={() => { location.hash = '#/'; }}>Go to my week</button>
        </div>
      )}
    </section>
  );
}
