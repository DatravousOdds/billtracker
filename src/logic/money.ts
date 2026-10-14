// All money is stored as whole cents (integers) to avoid floating-point errors.

const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatCents(cents: number): string {
  return fmt.format(cents / 100);
}

/** "1,234.5" or "$12" → cents. Returns null if it isn't a valid amount. */
export function parseDollars(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Split a total into parts by ratio so the parts always add up exactly to the total.
 * Leftover cents go to the parts with the largest fractional remainders.
 */
export function splitByRatio(total: number, ratios: number[]): number[] {
  const sum = ratios.reduce((a, b) => a + b, 0);
  if (ratios.length === 0) return [];
  const weights = sum > 0 ? ratios.map((r) => r / sum) : ratios.map(() => 1 / ratios.length);
  const raw = weights.map((w) => total * w);
  const parts = raw.map((r) => Math.floor(r));
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, rem: r - Math.floor(r) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k].i]++;
  return parts;
}
