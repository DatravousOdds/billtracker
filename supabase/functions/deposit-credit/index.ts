import { addDays, weekStart } from '../../../src/logic/dates.ts';
import { applyDepositCredit, depositDue, incomeShares } from '../../../src/logic/split.ts';
import { calculateSettlements, type SettlementInputs } from './settlement.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const encoder = new TextEncoder();
const revisionKey = crypto.subtle.importKey('raw', encoder.encode(service),
  { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { ...cors, 'Cache-Control': 'no-store' } });
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await fetch(url + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: { apikey: service, Authorization: 'Bearer ' + service, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!result.ok) throw new Error(name + ' failed with status ' + result.status);
  const body = await result.text();
  return (body ? JSON.parse(body) : null) as T;
}

interface Confirmation {
  confirmationId: string;
  amountCents: number;
  revision: string;
  quoteDate: string;
  periodStart: string;
}

function isConfirmation(value: unknown): value is Confirmation {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<Confirmation>;
  const date = (s: unknown) => typeof s === 'string' && !s.startsWith('0000-') && /^\d{4}-\d{2}-\d{2}$/.test(s)
    && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  return typeof v.confirmationId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v.confirmationId)
    && typeof v.amountCents === 'number' && Number.isSafeInteger(v.amountCents) && v.amountCents > 0
    && typeof v.revision === 'string' && /^[0-9a-f]{64}$/.test(v.revision)
    && date(v.quoteDate) && date(v.periodStart);
}

type CreditQuote = ReturnType<typeof calculateSettlements>['members'][string] & { fallback?: true };

function depositQuotes(
  inputs: SettlementInputs,
  members: ReturnType<typeof calculateSettlements>['members'],
): Record<string, CreditQuote> {
  const quotes: Record<string, CreditQuote> = { ...members };
  const household = inputs.households?.[0];
  if (!household) return quotes;
  const today = new Date(inputs.asOf).toISOString().slice(0, 10);
  const week = weekStart(today);
  const shares = incomeShares(inputs.members ?? [], inputs.paychecks ?? [], today, household);
  for (const { member } of shares) {
    if (quotes[member.user_id]) continue;
    const deposits = inputs.contributions ?? [];
    const due = depositDue(member, today, household.weekly_mode, inputs.bills ?? [], inputs.payments ?? [], shares, deposits);
    if (due.weeks === 0) continue;
    const deposited = deposits
      .filter((c) => c.member_id === member.user_id && c.week_start === week)
      .reduce((sum, c) => sum + c.amount_cents, 0);
    quotes[member.user_id] = {
      ...applyDepositCredit(due.cents, deposited, 0, 0), baseCents: due.cents,
      periodStart: week, nextPeriodStart: addDays(week, 7), fallback: true,
    };
  }
  return quotes;
}

async function quoteRevision(caller: string, inputs: SettlementInputs) {
  // The raw sequence can reveal writes across households.
  const bytes = encoder.encode(`deposit-credit:${caller}:${inputs.householdId}:${inputs.revision}`);
  const signature = await crypto.subtle.sign('HMAC', await revisionKey, bytes);
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function confirm(caller: string, request: Confirmation) {
  const inputs = await rpc<SettlementInputs | null>('deposit_credit_inputs', { caller });
  if (!inputs) return json({ error: 'No household found' }, 403);
  const quoteDate = new Date(inputs.asOf).toISOString().slice(0, 10);
  const quote = depositQuotes(inputs, calculateSettlements(inputs).members)[caller];
  const valid = quote?.periodStart === request.periodStart && quote.remainingCents > 0
    && weekStart(quote.periodStart) === weekStart(quoteDate);
  // The RPC checks the receipt before quote validity, so a response lost after
  // commit can be retried with the original ID even after the quote changes.
  const status = await rpc<string>('confirm_deposit_credit', {
    caller, home: inputs.householdId, expected_revision: inputs.revision,
    quote_date: request.quoteDate, quoted_period: request.periodStart,
    confirmation: request.confirmationId, amount: request.amountCents,
    quote_valid: valid && await quoteRevision(caller, inputs) === request.revision && quoteDate === request.quoteDate,
  });
  if (status === 'forbidden') return json({ error: 'No household found' }, 403);
  if (status === 'invalid') return json({ error: 'Invalid confirmation' }, 400);
  return json({ status });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'Sign in to see deposit credit' }, 401);
  try {
    const auth = await fetch(url + '/auth/v1/user', { headers: { apikey: anon, Authorization: authorization } });
    if (!auth.ok) return json({ error: 'Sign in to see deposit credit' }, 401);
    const caller = (await auth.json()).id;
    const body = await request.text();
    if (body) {
      let confirmation: unknown;
      try { confirmation = JSON.parse(body); }
      catch { return json({ error: 'Invalid confirmation' }, 400); }
      if (!isConfirmation(confirmation)) return json({ error: 'Invalid confirmation' }, 400);
      return await confirm(caller, confirmation);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const inputs = await rpc<SettlementInputs | null>('deposit_credit_inputs', { caller });
      if (!inputs) return json({ error: 'No household found' }, 403);
      const { closed, members, claims, watermark } = calculateSettlements(inputs);
      const departed = inputs.settlements?.some((settlement) => !inputs.members?.some((member) =>
        member.user_id === settlement.member_id
        && Date.parse(member.created_at) === Date.parse(settlement.member_created_at)));
      if (!closed.length && !claims.length && !departed && watermark === inputs.watermark) {
        return json({ asOf: inputs.asOf, revision: await quoteRevision(caller, inputs), members: depositQuotes(inputs, members) });
      }
      const saved = await rpc<boolean>('save_deposit_credit', {
        caller, home: inputs.householdId, expected_revision: inputs.revision,
        prune_before: watermark, periods: closed, claims,
      });
      if (saved) return json({ asOf: inputs.asOf, revision: await quoteRevision(caller, inputs), members: depositQuotes(inputs, members) });
    }
    return json({ error: 'Deposit credit changed. Try again.' }, 503);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Deposit credit failed');
    return json({ error: 'Deposit credit is temporarily unavailable' }, 503);
  }
});
