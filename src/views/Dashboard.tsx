import { useEffect, useRef, useState, type FormEvent } from 'react';
import { addDays, addMonths, formatShort, todayISO, toDate, weekStart } from '../logic/dates';
import { formatCents, parseDollars, centsToInput } from '../logic/money';
import { depositDue, ledger, leftover, needsConfirming, payWindow, periodPlan, weekLeftover, weekPlan, type DepositCredit, type DepositDue, type Leftover } from '../logic/split';
import { addContribution, decideRequest, depositPayday, homeName, load, memberName, shares } from '../store';
import type { BillRequest, ISODate, Member } from '../types';
import { useAppState, useBusy } from '../ui/hooks';
import { AsyncButton, BalanceSheet, BillAccountLine, OccurrenceRow, You, pct } from '../ui/parts';
import { Sheet } from '../ui/Sheet';
import { toast } from '../ui/toast';
import { depositCreditEnabled, supabase } from '../supabase';

type CreditQuote = DepositCredit & { due: DepositDue; periodStart: string; nextPeriodStart: string; fallback?: true };

type CreditQuotes = { asOf: string; revision: string; members: Record<string, CreditQuote> };
type QuoteConfirmation = { periodStart: string; quoteDate: string; revision: string };

async function depositCreditQuotes() {
  const { data, error } = await supabase.functions.invoke<CreditQuotes>('deposit-credit');
  if (error || !data?.members || !data.revision) throw new Error('Could not load deposit credit');
  return data;
}

export function DashboardView() {
  const s = useAppState();
  const [deposit, setDeposit] = useState<{ amount: number; max: number | null; week: ISODate; note?: string; quote?: QuoteConfirmation } | null>(null);
  const [enteringBalance, setEnteringBalance] = useState(false);
  const [credit, setCredit] = useState<{ state: typeof s; date: string; quotes?: CreditQuotes }>();
  const [retry, setRetry] = useState(0);
  const today = todayISO();
  useEffect(() => {
    if (!depositCreditEnabled) return;
    let active = true;
    depositCreditQuotes().then(
      (quotes) => { if (active) setCredit({ state: s, date: today, quotes }); },
      () => { if (active) setCredit({ state: s, date: today }); },
    );
    return () => { active = false; };
  }, [s, today, retry]);
  const currentCredit = credit?.state === s && credit.date === today ? credit : undefined;
  const quotes = currentCredit?.quotes;
  const creditLoading = depositCreditEnabled && !currentCredit;
  const creditUnavailable = depositCreditEnabled && !creditLoading && !quotes;
  const sh = shares();
  const plan = weekPlan(today, s.household.weekly_mode, s.bills, s.payments, sh);
  const smoothed = plan.mode === 'smoothed';
  // Pay as due with your payday saved: the top card and its list follow your pay window, not the calendar week.
  const me = sh.find((x) => x.member.user_id === s.userId)?.member;
  const win = !smoothed && me ? payWindow(me, today) : null;
  const top = win ? periodPlan(win.from, win.to, 'due', s.bills, s.payments, sh) : plan;
  const range = win && `${formatShort(win.from)} – ${formatShort(win.to)}`;
  // Bills that came due and nobody has confirmed paying yet. Shown first, and left out
  // of the bill list below so they don't appear twice.
  const toConfirm = needsConfirming(s.bills, s.payments, today);
  const key = (o: { bill: { id: string }; date: string }) => `${o.bill.id}|${o.date}`;
  const confirmKeys = new Set(toConfirm.map(key));
  const restThisWeek = top.dueThisWeek.filter((o) => !confirmKeys.has(key(o)));
  const led = ledger(s.bills, s.payments, s.contributions, sh);
  const pending = s.requests.filter((r) => r.status === 'pending');

  // ----- Who pays what -----
  const deposited = (memberId: string, week: ISODate) => s.contributions
    .filter((c) => c.member_id === memberId && c.week_start === week)
    .reduce((sum, c) => sum + c.amount_cents, 0);

  const enterBalance = () => setEnteringBalance(true);
  const dueOf = (m: Member) => depositDue(m, today, plan.mode, s.bills, s.payments, sh, s.contributions, s.accountBalances);
  const myDue = me ? dueOf(me) : null;
  // My card already has an "Enter shared account balance" button, so the running balance card doesn't need one.
  const cardAsks = !!myDue && myDue.balanceCents === null && (myDue.cents > 0 || deposited(s.userId, myDue.week) > 0);
  // Pay as due lists you first.
  const perMember = smoothed ? plan.perMember
    : [...plan.perMember].sort((a, b) => Number(b.member.user_id === s.userId) - Number(a.member.user_id === s.userId));

  const noIncome = sh.every((x) => x.income.monthlyCents === 0);
  const splitBy = s.household.split_proposed_by;
  const onlyOne = s.members.length < 2;

  // ----- Left after bills -----
  // Hidden until someone has income: the 50/50 fallback would show made-up negatives.
  const monthStart = today.slice(0, 8) + '01';
  const weekLeft = weekLeftover(today, plan.mode, s.bills, s.payments, sh, s.contributions, s.paychecks, s.accountBalances);
  const monthLeft = leftover(s.bills, s.payments, sh, monthStart, addDays(addMonths(monthStart, 1), -1), 'month', s.paychecks, !smoothed);
  const monthName = toDate(monthStart).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const home = homeName();
  const math = (l: Leftover, income = 'income', shared = 'shared') =>
    `${formatCents(l.incomeCents)} ${income} − ${formatCents(l.sharedCents)} ${shared}${l.personalCents ? ` − ${formatCents(l.personalCents)} personal` : ''}`;

  // ----- Balance -----
  const ahead = led.balances.find((b) => b.balanceCents > 0);
  const running = <>
    <div className="eyebrow">Running balance</div>
    <div>
      {ahead && s.members.length === 2
        ? <>{ahead.member.display_name} has covered <strong>{formatCents(ahead.balanceCents)}</strong> more than their share</>
        : "You're both even"}
    </div>
  </>;

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

      {!smoothed && me && !win && (
        <div className="card note">Set your next payday on the <a href="#/income">Income</a> tab to see the bills it covers.</div>
      )}

      <div className="card hero">
        <div className="hero-head">
          <div className="eyebrow">{win ? `Total due through ${formatShort(win.to)}` : <>This week · {formatShort(plan.weekStart)} – {formatShort(plan.weekEnd)}</>}</div>
          <span className="mode-tag">{smoothed ? 'Smoothed' : 'Pay as due'}</span>
        </div>
        <div className="hero-total">{formatCents(top.sharedTotalCents)}</div>
        {win && top.overdueCents > 0 ? (
          <div className="split-rows">
            <div><span>Overdue bills</span><span>{formatCents(top.overdueCents)}</span></div>
            <div><span>Bills due {range}</span><span>{formatCents(top.sharedTotalCents - top.overdueCents)}</span></div>
          </div>
        ) : (
          <div className="muted small">
            {smoothed
              ? `${formatCents(plan.regularCents)} weekly average${plan.oneTimeCents ? ` + ${formatCents(plan.oneTimeCents)} one-time bills` : ''}`
              : win ? `Bills due ${range}` : 'Left to pay this week, including overdue'}
          </div>
        )}
        <div className={`people${smoothed ? '' : ' rows'}`}>
          {!smoothed && <div className="eyebrow">To deposit</div>}
          {perMember.map((p) => {
            const isMe = p.member.user_id === s.userId;
            const mine = isMe && !smoothed;
            const quote = quotes?.members[p.member.user_id];
            const scheduled = !smoothed || !quote || weekStart(quote.periodStart) === plan.weekStart;
            const due = scheduled && quote ? quote.due : dueOf(p.member);
            const done = scheduled && quote ? quote.depositedCents : deposited(p.member.user_id, due.week);
            const remaining = scheduled && quote ? quote.remainingCents : Math.max(0, due.cents - done);
            const target = scheduled && quote ? done + remaining : due.cents;
            const confirmation = scheduled && quote && quotes ? {
              periodStart: quote.periodStart, quoteDate: new Date(quotes.asOf).toISOString().slice(0, 10),
              revision: quotes.revision,
            } : undefined;
            const amount = creditLoading ? <div className="muted small">Checking deposit credit…</div>
              : creditUnavailable ? <div className="muted small" role="status">
                Deposit credit is temporarily unavailable. <button type="button" className="pill" onClick={() => {
                  setCredit(undefined);
                  setRetry((value) => value + 1);
                }}>Try again</button>
              </div>
              : <div className={`person-amt${!smoothed && !target ? ' muted' : ''}`}>
                {formatCents(quote && !quote.fallback ? (scheduled ? remaining : 0) : due.cents)}
              </div>;
            // contributions are sorted newest first, so the first match is the partner's latest.
            const last = !isMe ? s.contributions.find((c) => c.member_id === p.member.user_id) : undefined;
            const lastPay = last && depositPayday(last.member_id, last.week_start);
            const rows = [
              ...(due.overdueCents > 0 ? [['Overdue', due.overdueCents] as const] : []),
              ...due.weekCents.map((c, i) => {
                const wk = addDays(due.from, 7 * i);
                return [wk === plan.weekStart ? 'This week' : `Week of ${formatShort(wk)}`, c] as const;
              }),
            ];
            const covers = due.weeks === 0 ? (due.lastPayday ? `Covered by ${isMe ? 'your' : 'their'} ${formatShort(due.lastPayday)} pay` : 'Nothing due until payday')
              : due.weeks === 1 && due.from === plan.weekStart ? (!smoothed && !due.cents && !due.creditCents ? 'Nothing due this week' : 'This week')
              : `Covers ${formatShort(due.from)} – ${formatShort(due.to)}`;
            const confirmDeposit = () => setDeposit({
              amount: remaining, max: due.limitCents === null ? null : due.limitCents - done,
              week: due.week, note: smoothed ? undefined : covers, quote: confirmation,
            });
            return (
              <div className="person" key={p.member.user_id}>
                {!smoothed ? (
                  <div className="person-row">
                    <div>
                      <div className="person-name">{p.member.display_name}<You show={isMe} /><span className="muted"> · {pct(p.ratio)}</span></div>
                      <div className="muted small">{covers}</div>
                      {mine && due.overdueCents > 0 && <div className="muted small">Includes {formatCents(due.overdueCents)} overdue</div>}
                    </div>
                    {amount}
                  </div>
                ) : (<>
                  <div className="person-top">
                    <span className="person-name">{p.member.display_name}<You show={isMe} /></span>
                    <span className="person-pct" title="Share of shared bills">{pct(p.ratio)}</span>
                  </div>
                  <div className="eyebrow">To deposit</div>
                  {/* The whole deposit: on a payday week it covers until the next payday (pay as due: starting next week). */}
                  {amount}
                  <div className="muted small">{covers}{due.nextPayday && <><br />Next payday {formatShort(due.nextPayday)}</>}</div>
                  {(!quote || quote.fallback || quote.appliedCreditCents === 0) && rows.length > 1 && (
                    <div className="split-rows">
                      {rows.map(([label, c]) => <div key={label}><span>{label}</span><span>{formatCents(c)}</span></div>)}
                    </div>
                  )}
                </>)}
                {mine && due.creditCents !== 0 && (
                  <div className="split-rows">
                    <div><span>Your share of bills</span><span>{formatCents(due.overdueCents + due.weekCents.reduce((sum, c) => sum + c, 0))}</span></div>
                    {due.creditCents > 0
                      ? <div><span>{formatCents(due.spareCents)} extra in the account</span><span>−{formatCents(due.creditCents)}</span></div>
                      : <div><span>Account is {formatCents(-due.spareCents)} short</span><span>+{formatCents(-due.creditCents)}</span></div>}
                    <div>
                      {due.creditCents < 0 ? `Your ${pct(p.ratio)} is added so the bills still get paid.`
                        : due.cents === 0 && done === 0 ? `Your ${pct(p.ratio)} of the extra covers this whole deposit.`
                        : `Your ${pct(p.ratio)} of the extra comes off your deposit.`}
                    </div>
                  </div>
                )}
                {due.shortCents > 0 && <div className="small danger-text">{formatCents(due.shortCents)} more than {isMe ? 'your' : 'their'} paycheck covers</div>}
                {!win && p.personalCents > 0 && <div className="muted small">+ {formatCents(p.personalCents)} personal bills this week</div>}
                {mine && due.balanceCents !== null && (
                  <div className="account-line">
                    <span>Account balance: {formatCents(due.balanceCents)}</span>
                    <button type="button" className="link-btn" aria-haspopup="dialog" onClick={enterBalance}>Edit</button>
                  </div>
                )}
                {quote && (quote.paidDirectCents > 0 || quote.priorCreditCents > 0) && (
                  <div className="split-rows">
                    <div><span>Deposit before direct-payment credit</span><span>{formatCents(quote.due.cents)}</span></div>
                    {quote.paidDirectCents > 0 && <div><span>Paid from {isMe ? 'your' : 'their'} account</span><span>{formatCents(quote.paidDirectCents)}</span></div>}
                    {quote.priorCreditCents > 0 && <div><span>Credit carried from last period</span><span>{formatCents(quote.priorCreditCents)}</span></div>}
                    <div><span>Credit applied to this deposit</span><span>−{formatCents(quote.appliedCreditCents)}</span></div>
                    {quote.carryCents > 0 && <div><strong>Credit for the next deposit</strong><strong>{formatCents(quote.carryCents)}</strong></div>}
                  </div>
                )}
                {done > 0 && done < target && <div className="muted small">{formatCents(done)} deposited so far</div>}
                {/* Only you can confirm your own deposit; your partner's card just shows their status. */}
                {creditLoading || creditUnavailable || (depositCreditEnabled && !confirmation) ? null
                  : quote && scheduled && remaining === 0 && quote.appliedCreditCents > 0 ? <span className="pill paid">✓ Covered by credit and deposits</span>
                  : mine ? (target === 0 && done === 0 ? due.creditCents > 0 && <div className="covered">Covered by what's in the account</div>
                  : done >= target ? <>
                      <span className="pill paid">✓ Deposited</span>
                      {due.balanceCents === null && <button type="button" className="link-btn block" aria-haspopup="dialog" onClick={enterBalance}>Enter shared account balance</button>}
                    </>
                  : due.balanceCents === null ? <>
                      <div className="muted small">Enter what's in the shared account to see your exact deposit.</div>
                      <button type="button" className="btn primary block" aria-haspopup="dialog" onClick={enterBalance}>Enter shared account balance</button>
                      <button type="button" className="link-btn block" aria-haspopup="dialog" onClick={confirmDeposit}>Skip this and confirm my deposit</button>
                    </>
                  : <button type="button" className="btn primary block" aria-haspopup="dialog" onClick={confirmDeposit}>{done > 0 ? 'Confirm the rest' : 'Confirm my deposit'}</button>)
                  : (due.weeks === 0 || (!smoothed && target === 0)) && done === 0 ? null
                  : done >= target && done > 0 ? <span className="pill paid">✓ Deposited</span>
                  : isMe ? <button type="button" className="pill" onClick={confirmDeposit}>{done > 0 ? 'Confirm the rest' : 'Confirm my deposit'}</button>
                  : <span className="badge person-status">{done > 0 ? 'Partly deposited' : 'Not deposited yet'}</span>}
                {!win && last && <div className="muted small">Last deposit: {formatCents(last.amount_cents)} · {lastPay ? `for ${formatShort(lastPay)} pay` : `week of ${formatShort(last.week_start)}`}</div>}
              </div>
            );
          })}
        </div>
      </div>

      {!noIncome && (
        <div className="card">
          <div className="eyebrow">Left after bills · {home.toLowerCase()}</div>
          <div className="people">
            {weekLeft.map((w, i) => (
              <div className="person" key={w.member.user_id}>
                <span className="person-name">{w.member.display_name}<You show={w.member.user_id === s.userId} /></span>
                <div className={`person-amt${w.leftCents < 0 ? ' danger-text' : ''}`}>{formatCents(w.leftCents)}</div>
                <div className="muted small">
                  {monthName}: <span className={monthLeft[i].leftCents < 0 ? 'danger-text' : ''}>{formatCents(monthLeft[i].leftCents)}</span>
                </div>
              </div>
            ))}
          </div>
          <details className="how">
            <summary>How it's worked out</summary>
            <p className="muted small">{smoothed ? 'Income minus the bills due in each period, paid or not.' : `${home}: your pay, minus your deposit (it includes your share of overdue bills), minus your personal bills. ${monthName}: income minus the bills due that month, paid or not, and any unpaid bills from before it.`} If you log each paycheck, {monthName} income is the checks dated in {monthName}.{smoothed ? ' Uses bills actually due, not the smoothed weekly amount.' : ''}</p>
            {weekLeft.map((w, i) => (
              <p className="muted small" key={w.member.user_id}>
                <strong>{w.member.display_name}</strong><br />
                {home}: {smoothed ? math(w) : math(w, 'pay', 'deposit')}<br />
                {monthName}: {math(monthLeft[i])}
              </p>
            ))}
          </details>
        </div>
      )}

      <h2 className="section-title">{win ? `Bills due ${range}` : 'Due this week'}</h2>
      {restThisWeek.length > 0 && <p className="muted small section-hint">Tap a bill to edit it</p>}
      {restThisWeek.length
        ? <ul className="list">{restThisWeek.map((o) => <OccurrenceRow key={key(o)} o={o} today={today} />)}</ul>
        : <p className="empty">{toConfirm.length ? 'Nothing else' : 'Nothing'} due {win ? 'until payday' : 'this week'}.</p>}

      {smoothed ? (
        <a className="card balance" href="#/history">
          <div>
            {running}
            <div className="muted small">Bill account: {formatCents(led.accountCents)} (deposits minus bills paid from it)</div>
          </div>
          <span aria-hidden="true">›</span>
        </a>
      ) : (
        <div className="card">
          <a className="balance" href="#/history">
            <div>{running}</div>
            <span aria-hidden="true">›</span>
          </a>
          <BillAccountLine onEnter={cardAsks ? undefined : enterBalance} />
        </div>
      )}

      {deposit && <DepositSheet amountCents={deposit.amount} maxCents={deposit.max} weekStart={deposit.week} note={deposit.note} onClose={() => setDeposit(null)}
        confirm={deposit.quote ? async (amount, confirmationId) => {
          const { data, error } = await supabase.functions.invoke<{ status: string }>('deposit-credit', {
            body: { ...deposit.quote, confirmationId, amountCents: amount },
          });
          if (error || !data) throw new Error('Could not confirm the deposit. Try again.');
          if (data.status === 'busy') throw new Error('Your deposit is being updated. Try again.');
          setCredit(undefined);
          setRetry((value) => value + 1);
          if (data.status === 'stale') {
            setDeposit(null);
            toast('Your deposit estimate changed. Review the new amount.', 'error');
            return false;
          }
          if (data.status !== 'saved') throw new Error('Could not confirm the deposit. Try again.');
          void load(s.userId, s.household.id).catch(console.error);
          return true;
        } : undefined} />}
      {enteringBalance && <BalanceSheet onClose={() => setEnteringBalance(false)} />}
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

function DepositSheet({ amountCents, maxCents, weekStart, note, onClose, confirm }: {
  amountCents: number; maxCents: number | null; weekStart: string; note?: string; onClose: () => void;
  confirm?: (amount: number, id: string) => Promise<boolean>;
}) {
  const [busy, run] = useBusy();
  const attempt = useRef<{ amount: number; id: string } | null>(null);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const amount = parseDollars(String(new FormData(e.currentTarget).get('amount')));
    if (amount === null || (confirm && amount <= 0)) return toast('Enter an amount like 120.50', 'error');
    if (maxCents !== null && amount > maxCents) {
      return toast(`That's more than your paycheck. You can deposit up to ${formatCents(Math.max(maxCents, 0))}${note ? '' : ' this week'}.`, 'error');
    }
    run(async () => {
      if (confirm) {
        if (attempt.current?.amount !== amount) attempt.current = { amount, id: crypto.randomUUID() };
        if (!(await confirm(amount, attempt.current.id))) return;
      } else {
        await addContribution(weekStart, amount);
      }
      onClose();
      toast('Deposit saved');
    });
  };
  return (
    <Sheet title="Confirm your deposit" onClose={onClose}>
      <form className="sheet-body form" onSubmit={submit}>
        <p className="muted">{note ?? `Your deposit · week of ${formatShort(weekStart)}`}</p>
        <label>Amount you deposited
          <input name="amount" inputMode="decimal" required defaultValue={centsToInput(Math.max(amountCents, 0))} />
        </label>
        <button className="btn primary block" type="submit" disabled={busy}>Yes, I deposited this</button>
      </form>
    </Sheet>
  );
}
