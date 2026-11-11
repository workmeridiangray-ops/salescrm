/**
 * Quote money rules. Mirrors app.quote_totals in SQL (tests/db/quotes.test.ts
 * compares the two). Rounding: half away from zero to 2 decimals, per line.
 *  net      = round(qty * unit_price)
 *  discount = round(net * discount% / 100)
 *  tax      = round((net - discount) * rate% / 100)
 */
export type QuoteLineInput = { qty: number; unitPrice: number; taxRate: number };
export type QuoteTotals = { subtotal: number; discountTotal: number; taxTotal: number; total: number };

// Work in integer paise to avoid float drift, rounding half away from zero like Postgres numeric.
const toPaise = (x: number) => Math.round((x + Number.EPSILON) * 100);
const roundDiv = (num: number, den: number) => Math.sign(num) * Math.floor((Math.abs(num) * 2 + den) / (den * 2));

export function calcQuote(lines: QuoteLineInput[], discountPct: number): QuoteTotals {
  let subtotal = 0, discountTotal = 0, taxTotal = 0;
  for (const l of lines) {
    const net = roundDiv(Math.round(l.qty * 1000) * toPaise(l.unitPrice), 1000);
    const disc = roundDiv(net * Math.round(discountPct * 100), 10000);
    const tax = roundDiv((net - disc) * Math.round(l.taxRate * 100), 10000);
    subtotal += net; discountTotal += disc; taxTotal += tax;
  }
  const f = (p: number) => p / 100;
  return { subtotal: f(subtotal), discountTotal: f(discountTotal), taxTotal: f(taxTotal), total: f(subtotal - discountTotal + taxTotal) };
}

export const NEEDS_APPROVAL = (discountPct: number, thresholdPct: number) => discountPct > thresholdPct;

export const QUOTE_STATUS_LABEL: Record<string, string> = {
  draft: "Draft", pending_approval: "Awaiting approval", approved: "Approved", sent: "Sent to customer",
  accepted: "Accepted", rejected: "Declined", expired: "Expired", superseded: "Superseded",
};

/** A sent quote past its date is effectively expired even before the status is updated. */
export function effectiveStatus(status: string, validUntil: string, today = new Date().toISOString().slice(0, 10)) {
  return status === "sent" && validUntil < today ? "expired" : status;
}

export const currentPeriod = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
export const isPeriod = (p: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(p);
export function shiftPeriod(p: string, delta: number) {
  const [y, m] = p.split("-").map(Number) as [number, number];
  const d = new Date(y, m - 1 + delta, 1);
  return currentPeriod(d);
}
