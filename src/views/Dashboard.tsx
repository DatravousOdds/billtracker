import { useState, type FormEvent } from 'react';
import { addDays, addMonths, formatShort, todayISO, toDate } from '../logic/dates';
import { formatCents, parseDollars, centsToInput } from '../logic/money';
import { depositDue, ledger, leftover, needsConfirming, weekPlan, type Leftover } from '../logic/split';
import { addContribution, decideRequest, memberName, shares } from '../store';
import type { BillRequest } from '../types';
import { useAppState, useBusy } from '../ui/hooks';
import { AsyncButton, OccurrenceRow, You, pct } from '../ui/parts';
import { Sheet } from '../ui/Sheet';
import { toast } from '../ui/toast';

export function DashboardView() {
  const s = useAppState();
  const [deposit, setDeposit] = useState<number | null>(null);
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
  const pending = s.requests.filter((r) => r.status === 'pending');

  // ----- Who pays what -----
  // A payday deposit can cover earlier weeks, so anything already put in for those weeks counts too.
  const deposited = (memberId: string, fromWeek: string) => s.contributions
    .filter((c) => c.member_id === memberId && c.week_start >= fromWeek && c.week_start <= plan.weekStart)
    .reduce((sum, c) => sum + c.amount_cents, 0);

  const noIncome = sh.every((x) => x.income.monthlyCents === 0);
  const splitBy = s.household.split_proposed_by;
  const onlyOne = s.members.length < 2;

  // ----- Left after bills -----
  // Hidden until someone has income: the 50/50 fallback would show made-up negatives.
  const monthStart = today.slice(0, 8) + '01';
  const weekLeft = leftover(s.bills, s.payments, sh, plan.weekStart, plan.weekEnd, 'week');
  const monthLeft = leftover(s.bills, s.payments, sh, monthStart, addDays(addMonths(monthStart, 1), -1), 'month');
  const monthName = toDate(monthStart).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const leftRow = (label: string, l: Leftover) => (
    <>
      <div className="muted small">{label}</div>
      <div className={`person-amt${l.leftCents < 0 ? ' danger-text' : ''}`}>{formatCents(l.leftCents)}</div>
      <div className="muted small">
        {formatCents(l.incomeCents)} income − {formatCents(l.sharedCents)} shared
        {l.personalCents ? ` − ${formatCents(l.personalCents)} personal` : ''}
      </div>
    </>
  );

  // ----- Balance -----
  const ahead = led.balances.find((b) => b.balanceCents > 0);

  return (
    <section className="view">
      {(pending.length > 0 || splitBy) && (
        <div className="stack">
          {/* A split change is approved on the Income tab, where the slider shows the amounts. */}
          {splitBy && (
            <a className="card request" href="#/income">
              {splitBy === s.userId
                ? 'You asked to change how you split bills. Waiting for your partner.'
                : <><strong>{memberName(splitBy)}</strong> wants to change how you split bills. Review it on the Income tab ›</>}
            </a>
          )}
          {pending.map((r) => <RequestCard key={r.id} r={r} />)}
        </div>
      )}
      {toConfirm.length > 0 && (
        <div className="card remind">
          <div className="remind-head">
            <span className="remind-icon" aria-hidden="true">🔔</span>
            <div>
              <strong>Did you pay {toConfirm.length === 1 ? 'this bill' : `these ${toConfirm.length} bills`}?</strong>
              <div className="muted small">{toConfirm.length === 1 ? "It's due. Confirm it once it's paid." : "They're due. Confirm each one once it's paid."}</div>
            </div>
          </div>
          <ul className="list">{toConfirm.map((o) => <OccurrenceRow key={key(o)} o={o} today={today} />)}</ul>
        </div>
      )}
      {onlyOne && <div className="card note">Your partner hasn't joined yet. Share invite code <strong>{s.household.invite_code}</strong> (also in Settings).</div>}
      {noIncome && s.household.split_percent === null && <div className="card note">Add income on the <a href="#/income">Income</a> tab so the split reflects what each of you earns. Until then it's 50/50.</div>}

      <div className="card hero">
        <div className="hero-head">
          <div>
            <div className="eyebrow">This week · {formatShort(plan.weekStart)} – {formatShort(plan.weekEnd)}</div>
            <div className="hero-total">{formatCents(plan.sharedTotalCents)}</div>
            <div className="muted small">
              {smoothed
                ? `${formatCents(plan.regularCents)} weekly average of shared bills${plan.oneTimeCents ? ` + ${formatCents(plan.oneTimeCents)} one-time bills due this week` : ''}`
                : 'Shared bills due this week'}
            </div>
          </div>
          <span className="mode-tag">{smoothed ? 'Smoothed' : 'Pay as due'}</span>
        </div>
        <div className="people">
          {plan.perMember.map((p) => {
            const isMe = p.member.user_id === s.userId;
            const due = depositDue(p.member, today, plan.mode, s.bills, s.payments, sh);
            const done = deposited(p.member.user_id, due.fromWeek);
            // contributions are sorted newest first, so the first match is the partner's latest.
            const last = !isMe && smoothed ? s.contributions.find((c) => c.member_id === p.member.user_id) : undefined;
            return (
              <div className="person" key={p.member.user_id}>
                <div className="person-top">
                  <span className="person-name">{p.member.display_name}<You show={isMe} /></span>
                  <span className="person-pct">{pct(p.ratio)}</span>
                </div>
                <div className="person-amt">{formatCents(p.sharedCents)}</div>
                {p.personalCents > 0 && <div className="muted small">+ {formatCents(p.personalCents)} personal bills this week</div>}
                {smoothed && due.weeks > 1 && <div className="muted small">{formatCents(due.cents)} to deposit · covers {due.weeks} weeks</div>}
                {done > 0 && done < due.cents && <div className="muted small">{formatCents(done)} deposited so far</div>}
                {/* Only you can confirm your own deposit; your partner's card just shows their status. */}
                {!smoothed ? null
                  : done >= due.cents && done > 0 ? <span className="pill paid">✓ Deposited</span>
                  : due.weeks === 0 ? <span className="muted small">{due.nextPayday ? `Payday ${formatShort(due.nextPayday)} · deposit then` : 'No payday this week · no deposit'}</span>
                  : isMe ? <button type="button" className="pill" onClick={() => setDeposit(due.cents - done)}>{done > 0 ? 'Confirm the rest' : 'Confirm my deposit'}</button>
                  : <span className="muted small">{done > 0 ? 'Partly deposited' : 'Not deposited yet'}</span>}
                {last && <div className="muted small">Last deposit: {formatCents(last.amount_cents)} · week of {formatShort(last.week_start)}</div>}
              </div>
            );
          })}
        </div>
      </div>

      {!noIncome && (
        <div className="card">
          <div className="eyebrow">Left after bills</div>
          <div className="muted small">Income minus the bills due in each period, paid or not.{smoothed ? ' Uses bills actually due, not the smoothed weekly amount.' : ''}</div>
          <div className="people">
            {weekLeft.map((w, i) => (
              <div className="person" key={w.member.user_id}>
                <span className="person-name">{w.member.display_name}<You show={w.member.user_id === s.userId} /></span>
                {leftRow('This week', w)}
                {leftRow(`This month · ${monthName}`, monthLeft[i])}
              </div>
            ))}
          </div>
        </div>
      )}

      <h2 className="section-title">Due this week</h2>
      {restThisWeek.length
        ? <ul className="list">{restThisWeek.map((o) => <OccurrenceRow key={key(o)} o={o} today={today} />)}</ul>
        : <p className="empty">{toConfirm.length ? 'Nothing else' : 'Nothing'} due this week.</p>}

      <a className="card balance" href="#/history">
        <div>
          <div className="eyebrow">Running balance</div>
          <div>
            {ahead && s.members.length === 2
              ? <>{ahead.member.display_name} has covered <strong>{formatCents(ahead.balanceCents)}</strong> more than their share</>
              : "You're both even"}
          </div>
          {smoothed && <div className="muted small">Bill account: {formatCents(led.accountCents)} (deposits minus bills paid from it)</div>}
        </div>
        <span aria-hidden="true">›</span>
      </a>

      {deposit !== null && <DepositSheet amountCents={deposit} weekStart={plan.weekStart} onClose={() => setDeposit(null)} />}
    </section>
  );
}

function RequestCard({ r }: { r: BillRequest }) {
  const s = useAppState();
  const bill = s.bills.find((b) => b.id === r.bill_id);
  const what = r.kind === 'make_personal'
    ? <>make <strong>{bill?.name}</strong> personal — {memberName(r.owner_id)} pays all of it</>
    : <>make <strong>{bill?.name}</strong> shared again — split by income</>;
  const decide = (decision: 'approved' | 'declined' | 'cancelled') => async () => {
    await decideRequest(r.id, decision);
    toast(decision === 'approved' ? 'Approved' : decision === 'declined' ? 'Declined' : 'Request cancelled');
  };
  if (r.requested_by === s.userId) {
    return (
      <div className="card request mine">
        <p>You asked to {what}. Waiting for your partner.</p>
        <AsyncButton className="btn ghost sm" onClick={decide('cancelled')}>Cancel request</AsyncButton>
      </div>
    );
  }
  return (
    <div className="card request">
      <p><strong>{memberName(r.requested_by)}</strong> wants to {what}.</p>
      <div className="row-actions">
        <AsyncButton className="btn ghost sm" onClick={decide('declined')}>Decline</AsyncButton>
        <AsyncButton className="btn primary sm" onClick={decide('approved')}>Approve</AsyncButton>
      </div>
    </div>
  );
}

function DepositSheet({ amountCents, weekStart, onClose }: { amountCents: number; weekStart: string; onClose: () => void }) {
  const [busy, run] = useBusy();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const amount = parseDollars(String(new FormData(e.currentTarget).get('amount')));
    if (amount === null) return toast('Enter an amount like 120.50', 'error');
    run(async () => {
      await addContribution(weekStart, amount);
      onClose();
      toast('Deposit saved');
    });
  };
  return (
    <Sheet title="Confirm your deposit" onClose={onClose}>
      <form className="sheet-body form" onSubmit={submit}>
        <p className="muted">Your deposit · week of {formatShort(weekStart)}</p>
        <label>Amount you deposited
          <input name="amount" inputMode="decimal" required defaultValue={centsToInput(Math.max(amountCents, 0))} />
        </label>
        <button className="btn primary block" type="submit" disabled={busy}>Yes, I deposited this</button>
      </form>
    </Sheet>
  );
}
