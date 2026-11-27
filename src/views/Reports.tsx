import { useEffect, useRef, useState } from 'react';
import { formatShort, toDate, todayISO } from '../logic/dates';
import { formatCents } from '../logic/money';
import { reportRanges, shiftReportAnchor, type ReportPeriod } from '../logic/reports';
import { getReportPayments, getReportSummary } from '../reports';
import { getVersion } from '../store';
import { useAppState } from '../ui/hooks';
import { errorMessage } from '../ui/toast';

type Summary = Awaited<ReturnType<typeof getReportSummary>>;
type PaymentPage = Awaited<ReturnType<typeof getReportPayments>>;
type Detail = { category: string; billId?: string; title: string; cents: number };
type Result<T> =
  | { key: string; kind: 'ready'; value: T }
  | { key: string; kind: 'error'; message: string };

const periods: ReportPeriod[] = ['week', 'month', 'year'];
const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortMonth = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
const paymentDate = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

export function ReportsView() {
  const state = useAppState();
  const version = getVersion();
  const today = todayISO();
  const [period, setPeriod] = useState<ReportPeriod>('month');
  const [anchor, setAnchor] = useState(today);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [summaryResult, setSummary] = useState<Result<Summary>>();
  const [paymentResult, setPayments] = useState<Result<PaymentPage>>();
  const [retry, setRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState('');
  const returnFocus = useRef<HTMLElement | null>(null);
  const returnScroll = useRef(0);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const request = useRef(0);
  const ranges = reportRanges(period, anchor, today);
  const summaryKey = JSON.stringify([state.household.id, state.userId, version, period, anchor, today, retry]);
  const paymentKey = JSON.stringify([summaryKey, detail?.category, detail?.billId]);

  useEffect(() => {
    let active = true;
    getReportSummary(state, reportRanges(period, anchor, today)).then(
      (value) => { if (active) setSummary({ key: summaryKey, kind: 'ready', value }); },
      (error: unknown) => { if (active) setSummary({ key: summaryKey, kind: 'error', message: errorMessage(error) }); },
    );
    return () => { active = false; };
  }, [state, period, anchor, today, summaryKey]);

  useEffect(() => {
    const id = ++request.current;
    setLoadingMore(false);
    setPageError('');
    if (detail) {
      getReportPayments(state, reportRanges(period, anchor, today).current, detail).then(
        (value) => { if (request.current === id) setPayments({ key: paymentKey, kind: 'ready', value }); },
        (error: unknown) => {
          if (request.current === id) setPayments({ key: paymentKey, kind: 'error', message: errorMessage(error) });
        },
      );
    }
    return () => { request.current++; };
  }, [state, period, anchor, today, detail, paymentKey]);

  useEffect(() => {
    if (detail) {
      window.scrollTo(0, 0);
      detailHeading.current?.focus({ preventScroll: true });
    } else if (returnFocus.current) {
      window.scrollTo(0, returnScroll.current);
      returnFocus.current.focus({ preventScroll: true });
      returnFocus.current = null;
    }
  }, [detail]);

  const summary = summaryResult?.key === summaryKey ? summaryResult : undefined;
  const payments = paymentResult?.key === paymentKey ? paymentResult : undefined;
  const report = summary?.kind === 'ready' ? summary.value : undefined;
  const difference = report ? report.paidCents - report.previousPaidCents : 0;
  const detailCategory = report && detail
    ? report.categories.find((category) => category.category === detail.category)
    : undefined;
  const detailCents = detail?.billId
    ? detailCategory?.bills.find((bill) => bill.id === detail.billId)?.cents
    : detailCategory?.cents;
  const from = toDate(ranges.current.from);
  const label = period === 'month' ? monthName.format(from) : period === 'year' ? String(from.getUTCFullYear())
    : `${formatShort(ranges.current.from)} – ${formatShort(ranges.periodEnd)}, ${toDate(ranges.periodEnd).getUTCFullYear()}`;

  function openDetail(next: Detail, trigger: HTMLElement) {
    returnFocus.current = trigger;
    returnScroll.current = window.scrollY;
    setDetail(next);
  }

  async function loadMore() {
    if (!detail || payments?.kind !== 'ready' || !payments.value.nextCursor || loadingMore) return;
    const id = request.current;
    setLoadingMore(true);
    setPageError('');
    try {
      const next = await getReportPayments(state, ranges.current, detail, payments.value.nextCursor);
      if (request.current === id) {
        setPayments({ key: paymentKey, kind: 'ready', value: { ...next, rows: [...payments.value.rows, ...next.rows] } });
      }
    } catch (error) {
      if (request.current === id) setPageError(errorMessage(error));
    } finally {
      if (request.current === id) setLoadingMore(false);
    }
  }

  function failure(message: string) {
    return <div className="card" role="alert"><p>{message}</p><button className="btn" onClick={() => setRetry(retry + 1)}>Retry</button></div>;
  }

  return (
    <>
      <section className="view reports" hidden={detail !== null}>
        <div className="view-head"><h1>Reports</h1></div>
        <div className="seg full report-periods" role="group" aria-label="Report period">
          {periods.map((choice) => (
            <button key={choice} type="button" className={period === choice ? 'on' : ''}
              aria-pressed={period === choice} onClick={() => setPeriod(choice)}>
              {choice[0].toUpperCase() + choice.slice(1)}
            </button>
          ))}
        </div>
        <div className="card report-period">
          <button className="btn ghost" aria-label={`Previous ${period}`} onClick={() => setAnchor(shiftReportAnchor(period, anchor, -1))}>‹</button>
          <div aria-live="polite">
            <strong>{label}</strong>
            {ranges.current.to < ranges.periodEnd && <div className="muted small">Through {formatShort(ranges.current.to)}</div>}
          </div>
          <button className="btn ghost" aria-label={`Next ${period}`} disabled={ranges.periodEnd >= today}
            onClick={() => {
              const next = shiftReportAnchor(period, anchor, 1);
              setAnchor(next > today ? today : next);
            }}>›</button>
        </div>

        {!summary && <p className="empty" role="status">Loading report…</p>}
        {summary?.kind === 'error' && failure(summary.message)}
        {report && (
          <>
            <div className="card">
              <div className="eyebrow">Recorded bills paid</div>
              <div className="report-amount">{formatCents(report.paidCents)}</div>
              {report.paidCents === 0 && <div className="muted small">No payments recorded</div>}
              <div className="report-line"><span>Unpaid bills due</span><strong>{formatCents(report.unpaidCents)}</strong></div>
              <div className="muted small">Autopay may be missing from recorded payments.</div>
              <div className="muted small">{difference === 0 ? 'Same spending as the prior period'
                : `${formatCents(Math.abs(difference))} ${difference < 0 ? 'less' : 'more'} than the prior period`}</div>
            </div>

            <div className="card">
              <h2>Left after bills <span className="muted small">· {monthName.format(toDate(ranges.leftover.from))}</span></h2>
              {report.members.map((member) => (
                <details className="report-member" key={member.id}>
                  <summary className="report-line">
                    <span>{member.name}{member.estimatedIncome && <span className="badge">Estimated income</span>}
                      <span className="muted small report-member-sub">{formatCents(member.incomeCents)} income · {formatCents(member.incomeCents - member.leftCents)} toward bills</span>
                    </span>
                    <strong className={member.leftCents < 0 ? 'neg' : 'pos'}>{formatCents(member.leftCents)}</strong>
                  </summary>
                  <dl className="report-breakdown">
                    <div className="report-line"><dt>Take-home income</dt><dd>{formatCents(member.incomeCents)}</dd></div>
                    <div className="report-line"><dt>Personal bills paid</dt><dd>{formatCents(member.personalCents)}</dd></div>
                    <div className="report-line"><dt>Deposited for shared bills</dt><dd>{formatCents(member.monthlyDepositedCents)}</dd></div>
                    <div className="report-line"><dt>Shared bills paid directly</dt><dd>{formatCents(member.monthlyDirectCents)}</dd></div>
                  </dl>
                </details>
              ))}
            </div>

            <div className="card">
              <h2>Shared bill contributions</h2>
              <p className="muted small">{label}</p>
              {report.members.map((member) => (
                <div className="report-member" key={member.id}>
                  <div className="report-line"><strong>{member.name}</strong><strong>{formatCents(member.depositedCents + member.directCents)}</strong></div>
                  <div className="muted small">Deposited {formatCents(member.depositedCents)} · Paid directly {formatCents(member.directCents)}</div>
                </div>
              ))}
            </div>

            {period === 'year' && <SpendingTrend report={report} />}

            {report.categories.length > 0 && <div className="card">
              <h2>Paid by category</h2>
              <ul className="list compact">
                {report.categories.map(({ category, cents, count, bills }) => (
                  <li key={category}>
                    <button type="button" className="report-drill report-line"
                      onClick={(event) => openDetail({ category, title: category, cents }, event.currentTarget)}>
                      <span>{category}<small className="muted"> · {count} {count === 1 ? 'payment' : 'payments'}</small></span>
                      <strong>{formatCents(cents)} ›</strong>
                    </button>
                    {bills.map((bill) => (
                      <button type="button" key={bill.id} className="report-drill report-bill report-line"
                        onClick={(event) => openDetail({ category, billId: bill.id, title: bill.name, cents: bill.cents }, event.currentTarget)}>
                        <span>{bill.name}</span><span>{formatCents(bill.cents)} ›</span>
                      </button>
                    ))}
                  </li>
                ))}
              </ul>
            </div>}
          </>
        )}
      </section>
      {detail && <section className="view reports">
        <div><button type="button" className="btn ghost" onClick={() => setDetail(null)}>‹ Back to Reports</button></div>
        <div className="card">
          <h1 ref={detailHeading} tabIndex={-1}>{detail.title}</h1>
          <p className="muted small">{label}</p>
          <div className="report-line"><span>Recorded bills paid</span><strong>{formatCents(detailCents ?? (summary?.kind === 'ready' ? 0 : detail.cents))}</strong></div>
        </div>
        {!payments && <p className="empty" role="status">Loading payments…</p>}
        {payments?.kind === 'error' && failure(payments.message)}
        {payments?.kind === 'ready' && (payments.value.rows.length === 0
          ? <p className="empty">No payments recorded</p>
          : <ul className="list">{payments.value.rows.map((payment) => (
            <li key={payment.id} className="occ">
              <div className="occ-main">
                <div className="occ-name">{payment.billName}</div>
                <div className="occ-sub">{paymentDate.format(toDate(payment.paidOn))} · {payment.paidBy
                  ? `Paid by ${state.members.find((m) => m.user_id === payment.paidBy)?.display_name ?? 'a former member'}`
                  : 'Paid from shared account'}</div>
              </div>
              <strong className="occ-amt">{formatCents(payment.cents)}</strong>
            </li>
          ))}</ul>)}
        {pageError && <p role="alert">{pageError}</p>}
        {payments?.kind === 'ready' && payments.value.nextCursor &&
          <button type="button" className="btn" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Loading…' : 'Load more payments'}
          </button>}
      </section>}
    </>
  );
}

const trendScale = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1,
});

function SpendingTrend({ report }: { report: Summary }) {
  const [mode, setMode] = useState<'household' | 'partners'>('household');
  const [selectedMonth, setSelectedMonth] = useState<string>();
  const comparing = mode === 'partners';
  const names = comparing ? report.members.map((member) => member.name) : ['Household bills paid'];
  const totalsByMember = new Map(report.monthlyContributions.map(({ month, memberId, cents }) => [`${month}/${memberId}`, cents]));
  const months = report.months.map(({ month, cents }) => ({
    month,
    amounts: comparing ? report.members.map(({ id }) => totalsByMember.get(`${month}/${id}`) ?? 0) : [cents],
  }));
  const highestCents = Math.max(0, ...months.flatMap(({ amounts }) => amounts));
  const selected = months.find(({ month }) => month === selectedMonth)
    ?? months.find(({ amounts }) => amounts.includes(highestCents));
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(100, highestCents)));
  const scaleStep = magnitude / 2;
  const ceiling = Math.ceil(highestCents / scaleStep) * scaleStep;

  return (
    <div className="card">
      <h2>Recorded payments by month</h2>
      <div className="seg full report-periods report-trend-mode" role="group" aria-label="Spending chart view">
        <button type="button" className={!comparing ? 'on' : ''} aria-pressed={!comparing}
          onClick={() => setMode('household')}>Household spending</button>
        <button type="button" className={comparing ? 'on' : ''} aria-pressed={comparing}
          onClick={() => setMode('partners')}>Compare partners</button>
      </div>
      {comparing && <p className="muted small">Shared bill contributions include deposits and shared bills each person paid directly.</p>}
      {highestCents > 0 && selected ? (
        <>
          <div className="report-trend-selection" aria-live="polite">
            {comparing && <strong>{monthName.format(toDate(selected.month))}</strong>}
            {selected.amounts.map((cents, index) => (
              <div className="report-line" key={index}>
                <span>{comparing && <i className="report-series-dot" data-series={index % 4} />}
                  {comparing ? names[index] : monthName.format(toDate(selected.month))}</span>
                <strong>{formatCents(cents)}</strong>
              </div>
            ))}
          </div>
          <div className="report-trend">
            <div className="report-trend-scale" aria-hidden="true">
              {[ceiling, ceiling / 2, 0].map((cents) => <span key={cents}>{trendScale.format(cents / 100)}</span>)}
            </div>
            <div className="report-trend-plot" role="group" aria-label={comparing ? 'Monthly contributions by partner' : 'Monthly bill spending'}>
              {months.map(({ month, amounts }) => (
                <button className="report-trend-column" key={month} type="button"
                  aria-label={`${monthName.format(toDate(month))}, ${amounts.map((cents, i) =>
                    comparing ? `${names[i]} ${formatCents(cents)}` : formatCents(cents)).join(', ')}`}
                  aria-pressed={selected.month === month} onClick={() => setSelectedMonth(month)}>
                  <span className="report-trend-track" data-comparing={comparing} aria-hidden="true">
                    {amounts.map((cents, index) => <span key={index} className="report-trend-bar"
                      data-series={index % 4} style={{ height: `${cents / ceiling * 100}%` }} />)}
                  </span>
                  <span className="report-trend-label" aria-hidden="true">{shortMonth.format(toDate(month))}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      ) : <p className="muted small">{comparing ? 'No shared bill contributions recorded' : 'No payments recorded'}</p>}
      <details className="report-trend-details">
        <summary>View monthly amounts</summary>
        <dl className="report-breakdown">
          {months.map(({ month, amounts }) => (
            <div key={month} className={comparing ? undefined : 'report-line'}>
              <dt>{shortMonth.format(toDate(month))}</dt>
              {amounts.map((cents, index) => (
                <dd key={index} className={comparing ? 'report-line' : undefined}>
                  {comparing && <span>{names[index]}</span>}
                  <span>{formatCents(cents)}</span>
                </dd>
              ))}
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
