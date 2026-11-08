import { calculateSettlements, type SettlementInputs } from './settlement.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
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

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'Sign in to see deposit credit' }, 401);
  try {
    const auth = await fetch(url + '/auth/v1/user', { headers: { apikey: anon, Authorization: authorization } });
    if (!auth.ok) return json({ error: 'Sign in to see deposit credit' }, 401);
    const caller = (await auth.json()).id;
    for (let attempt = 0; attempt < 3; attempt++) {
      const inputs = await rpc<SettlementInputs | null>('deposit_credit_inputs', { caller });
      if (!inputs) return json({ error: 'No household found' }, 403);
      const { closed, members, claims, watermark } = calculateSettlements(inputs);
      const departed = inputs.settlements?.some((settlement) => !inputs.members?.some((member) =>
        member.user_id === settlement.member_id
        && Date.parse(member.created_at) === Date.parse(settlement.member_created_at)));
      if (!closed.length && !claims.length && !departed && watermark === inputs.watermark) {
        return json({ asOf: inputs.asOf, members });
      }
      const saved = await rpc<boolean>('save_deposit_credit', {
        caller, home: inputs.householdId, expected_revision: inputs.revision,
        prune_before: watermark, periods: closed, claims,
      });
      if (saved) return json({ asOf: inputs.asOf, members });
    }
    return json({ error: 'Deposit credit changed. Try again.' }, 503);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Deposit credit failed');
    return json({ error: 'Deposit credit is temporarily unavailable' }, 503);
  }
});
