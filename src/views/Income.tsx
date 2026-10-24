import { useState, type FormEvent } from 'react';
import { addDays, formatShort, todayISO } from '../logic/dates';
import { FREQUENCY_LABEL, PER_YEAR, paychecksNeeded, paydays } from '../logic/income';
import { formatCents, parseDollars, centsToInput, splitByRatio } from '../logic/money';
import { monthlySharedTotal, type Share } from '../logic/split';
import type { PayFrequency } from '../types';
import { addPaycheck, decideSplit, deletePaycheck, proposeSplit, shares, updateMember } from '../store';
import { useAppState, useBusy } from '../ui/hooks';
import { AsyncButton, You, pct } from '../ui/parts';
import { toast } from '../ui/toast';

export function IncomeView() {
  const s = useAppState();
  const sh = shares();

  // Same "no income yet" test the dashboard uses, so the two screens agree.
  const needsPay = sh.find((x) => x.member.user_id === s.userId)?.income.monthlyCents === 0;

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h1>Income</h1>
          <p className="muted small">{s.household.split_percent !== null
            ? 'You both agreed on a custom split, so the percentages below come from that, not from income.'
            : 'Each of you pays the same percentage of shared bills as your share of combined income.'}</p>
        </div>
      </div>

      {needsPay && (
        <div className="card request">
          <strong>One last step:</strong> tell us about your pay so we can work out your share of the bills.
          <a href="#/setup" className="btn primary sm">Set up my pay</a>
        </div>
      )}

      {/* Keyed on the saved split so the slider resets when either phone changes it. */}
      <SplitCard key={[s.household.split_member, s.household.split_percent, s.household.split_proposed_by, s.household.split_proposed_percent].join('|')} />

      <div className="stack">
        {sh.map((share) => <MemberCard key={share.member.user_id} share={share} />)}
      </div>
      {s.members.length < 2 && <p className="empty">Your partner's income shows up here once they join with code <strong>{s.household.invite_code}</strong>.</p>}
    </section>
  );
}

function MemberCard({ share: { member: m, income, ratio } }: { share: Share }) {
  const s = useAppState();
  const [savingPay, runPay] = useBusy();
  const [logging, runLog] = useBusy();
  const checks = s.paychecks.filter((p) => p.member_id === m.user_id).slice(0, 8);
  const perPay = m.income_mode === 'per_paycheck';
  const auto = m.paycheck_average !== 'per_paycheck';
  // Only you can change your own income; your partner's card is read-only.
  const mine = m.user_id === s.userId;
  const n = paychecksNeeded(m.pay_frequency);
  const latest = `latest ${n === 1 ? 'paycheck' : `${n} paychecks`}`;
  const sourceNote = income.source === 'auto' || income.source === 'per_paycheck'
    ? `Average of the ${latest} × ${PER_YEAR[m.pay_frequency]} paychecks ÷ 12 months`
    : income.source === 'fallback'
      ? `Log ${n} paycheck${n === 1 ? '' : 's'} to use the average (${income.paychecksUsed} so far) — using usual pay below`
      : `${formatCents(m.pay_amount_cents)} × ${PER_YEAR[m.pay_frequency]} paychecks ÷ 12 months`;
  // Next payday on or after today, worked out from the one saved.
  const nextPayday = paydays(m, todayISO(), addDays(todayISO(), 62))[0] ?? null;

  const checkList = checks.length > 0 && (
    <ul className="list compact">
      {checks.map((p) => (
        <li className="occ" key={p.id}>
          <div className="occ-main"><div className="occ-sub">{formatShort(p.paid_on)}</div></div>
          <div className="occ-amt">{formatCents(p.amount_cents)}</div>
          {mine && (
            <AsyncButton className="icon-btn" aria-label="Remove paycheck" onClick={async () => {
              await deletePaycheck(p.id);
              toast('Paycheck removed');
            }}>✕</AsyncButton>
          )}
        </li>
      ))}
    </ul>
  );

  const savePay = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const amount = parseDollars(String(f.get('amount')));
    if (amount === null) return toast('Enter an amount like 1,250.00', 'error');
    const payday = String(f.get('payday')) || null;
    runPay(async () => {
      // Only send payday when it was changed, so Save pay keeps working before pay-schedule.sql has run.
      await updateMember(m.user_id, {
        pay_amount_cents: amount, pay_frequency: f.get('frequency') as PayFrequency, ...(payday !== nextPayday && { payday }),
      });
      toast('Pay saved');
    });
  };

  const logPaycheck = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const amount = parseDollars(String(f.get('amount')));
    if (amount === null) return toast('Enter an amount like 1,250.00', 'error');
    runLog(async () => {
      await addPaycheck(m.user_id, amount, String(f.get('paid_on')));
      form.reset();
      toast('Paycheck logged');
    });
  };

  return (
    <div className="card member">
      <div className="person-top">
        <h2>{m.display_name}<You show={mine} /></h2>
        <span className="person-pct">{pct(ratio)} of bills</span>
      </div>
      <div className="person-amt">{formatCents(Math.round(income.monthlyCents))}<span className="muted small"> / month</span></div>
      <p className="muted small">{sourceNote}</p>

      {!mine ? (
        <>
          <p className="small">
            {perPay ? 'Logs each paycheck' : 'Fixed pay'} · paid {FREQUENCY_LABEL[m.pay_frequency].toLowerCase()}
            {m.pay_amount_cents ? ` · usual paycheck ${formatCents(m.pay_amount_cents)}` : ''}
            {nextPayday ? ` · next payday ${formatShort(nextPayday)}` : ''}
          </p>
          {perPay && checkList}
        </>
      ) : (
        <>
          <div className="seg full" role="group" aria-label="Income mode">
            <AsyncButton className={!perPay ? 'on' : ''} onClick={async () => {
              await updateMember(m.user_id, { income_mode: 'fixed' });
              toast('Using fixed income');
            }}>Fixed</AsyncButton>
            <AsyncButton className={perPay ? 'on' : ''} onClick={async () => {
              await updateMember(m.user_id, { income_mode: 'per_paycheck' });
              toast('Now logging each paycheck');
            }}>Log each paycheck</AsyncButton>
          </div>

          {/* Keyed on the saved values so the fields refresh after a save. */}
          <form className="form pay-form" onSubmit={savePay} key={`${m.pay_amount_cents}|${m.pay_frequency}|${m.payday}`}>
            <div className="grid2">
              <label>{perPay ? 'Usual paycheck (backup)' : 'Paycheck amount'}
                <input name="amount" inputMode="decimal" placeholder="1,250.00" defaultValue={m.pay_amount_cents ? centsToInput(m.pay_amount_cents) : ''} />
              </label>
              <label>Paid
                <select name="frequency" defaultValue={m.pay_frequency}>
                  {(Object.keys(FREQUENCY_LABEL) as PayFrequency[]).map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
                </select>
              </label>
            </div>
            <label>Next payday (optional)
              <input name="payday" type="date" max={addDays(todayISO(), 364)} defaultValue={nextPayday ?? ''} />
              <span className="muted small">Deposits are only asked for in weeks you get paid.</span>
            </label>
            <button className="btn ghost sm" type="submit" disabled={savingPay}>Save pay</button>
          </form>

          {perPay && (
            <>
              <p className="small">How do you want to calculate the average?</p>
              <div className="seg full" role="group" aria-label="How to calculate the average">
                <AsyncButton className={auto ? 'on' : ''} onClick={async () => {
                  await updateMember(m.user_id, { paycheck_average: 'auto' });
                  toast('Averaging automatically');
                }}>Automatic</AsyncButton>
                <AsyncButton className={!auto ? 'on' : ''} onClick={async () => {
                  await updateMember(m.user_id, { paycheck_average: 'per_paycheck' });
                  toast('Averaging by paycheck');
                }}>By paycheck</AsyncButton>
              </div>
              <form className="form pay-form" onSubmit={logPaycheck}>
                <div className="grid2">
                  <label>Paycheck amount
                    <input name="amount" inputMode="decimal" required placeholder="0.00" />
                  </label>
                  <label>Date
                    <input name="paid_on" type="date" required defaultValue={todayISO()} />
                  </label>
                </div>
                <button className="btn primary sm" type="submit" disabled={logging}>Log paycheck</button>
              </form>
              {checkList}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Agreed split: one partner proposes a percentage with the slider, the other approves. */
function SplitCard() {
  const s = useAppState();
  const h = s.household;
  const partner = s.members.find((m) => m.user_id !== s.userId);
  const myRatio = shares().find((x) => x.member.user_id === s.userId)?.ratio ?? 0.5;
  const askedByMe = h.split_proposed_by === s.userId;
  const [pct, setPct] = useState(askedByMe && h.split_proposed_percent !== null
    ? h.split_proposed_percent
    : Math.min(99, Math.max(1, Math.round(myRatio * 100))));
  if (!partner) return null;

  const agreed = h.split_percent !== null && h.split_member !== null;
  const sharedMonthly = monthlySharedTotal(s.bills);
  const preview = (myPct: number) => {
    const [mine, theirs] = splitByRatio(sharedMonthly, [myPct, 100 - myPct]);
    return (
      <p>
        You pay <strong>{myPct}%</strong> · {formatCents(mine)}/mo<br />
        {partner.display_name} pays <strong>{100 - myPct}%</strong> · {formatCents(theirs)}/mo
      </p>
    );
  };
  const decide = (decision: 'approved' | 'declined' | 'cancelled') => async () => {
    await decideSplit(decision);
    toast(decision === 'approved' ? 'New split approved' : decision === 'declined' ? 'Declined' : 'Request cancelled');
  };
  const propose = (percent: number | null) => async () => {
    await proposeSplit(percent);
    toast(`Sent to ${partner.display_name} to approve`);
  };

  // The partner asked: approve or decline. A null percent means "back to splitting by income".
  if (h.split_proposed_by && !askedByMe) {
    const theirPct = h.split_proposed_percent;
    return (
      <div className="card request split">
        <p>
          <strong>{partner.display_name}</strong> wants to {theirPct === null
            ? 'go back to splitting shared bills by income'
            : `split shared bills ${theirPct}% ${partner.display_name} / ${100 - theirPct}% you`}.
        </p>
        {theirPct !== null && preview(100 - theirPct)}
        <div className="row-actions">
          <AsyncButton className="btn ghost sm" onClick={decide('declined')}>Decline</AsyncButton>
          <AsyncButton className="btn primary sm" onClick={decide('approved')}>Approve</AsyncButton>
        </div>
      </div>
    );
  }

  return (
    <div className="card split">
      <h2>Choose your own split</h2>
      <p className="muted small">{agreed
        ? 'You both agreed to this split instead of splitting by income.'
        : `Want a different split than by income? Slide to pick your share. Nothing changes until ${partner.display_name} approves.`}</p>
      <label>Your share of shared bills
        <input type="range" min={1} max={99} step={1} value={pct} onChange={(e) => setPct(Number(e.target.value))}
          aria-valuetext={`You ${pct}%, ${partner.display_name} ${100 - pct}%`} />
      </label>
      {preview(pct)}
      {askedByMe && (
        <p className="muted small">
          You asked to {h.split_proposed_percent === null
            ? 'go back to splitting shared bills by income'
            : `split shared bills ${h.split_proposed_percent}% you / ${100 - h.split_proposed_percent}% ${partner.display_name}`}.
          {' '}Waiting for {partner.display_name}.
        </p>
      )}
      <div className="row-actions">
        {askedByMe && <AsyncButton className="btn ghost sm" onClick={decide('cancelled')}>Cancel request</AsyncButton>}
        {agreed && !askedByMe && <AsyncButton className="btn ghost sm" onClick={propose(null)}>Go back to income split</AsyncButton>}
        <AsyncButton className="btn primary sm" onClick={propose(pct)}>{askedByMe ? 'Update request' : `Ask ${partner.display_name} to approve`}</AsyncButton>
      </div>
    </div>
  );
}
