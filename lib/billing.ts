import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify Razorpay's X-Razorpay-Signature (HMAC-SHA256 of the raw body). */
export function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type BillingEvent = {
  eventId: string;
  type: string;
  tenantId: string | null;
  planKey: string | null;
  interval: string | null;
  subscriptionId: string | null;
  periodEnd: string | null;
};

const HANDLED = new Set([
  "subscription.activated", "subscription.charged", "subscription.resumed",
  "subscription.pending", "subscription.halted", "subscription.cancelled", "subscription.completed",
]);

/** Pull what we need out of a Razorpay subscription event; null if we don't handle it. */
export function parseEvent(eventId: string | null, body: unknown): BillingEvent | null {
  const b = body as { event?: string; payload?: { subscription?: { entity?: Record<string, any> } } };
  if (!eventId || !b?.event || !HANDLED.has(b.event)) return null;
  const e = b.payload?.subscription?.entity;
  if (!e) return null;
  const notes = (e.notes ?? {}) as Record<string, string>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return {
    eventId,
    type: b.event,
    tenantId: notes.tenant_id && uuid.test(notes.tenant_id) ? notes.tenant_id : null,
    planKey: notes.plan_key ?? null,
    interval: notes.interval === "yearly" ? "yearly" : notes.interval === "monthly" ? "monthly" : null,
    subscriptionId: typeof e.id === "string" ? e.id : null,
    periodEnd: typeof e.current_end === "number" ? new Date(e.current_end * 1000).toISOString() : null,
  };
}
