import { NextResponse } from "next/server";
import { parseEvent, verifySignature } from "@/lib/billing";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get("x-razorpay-signature"), secret)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const ev = parseEvent(request.headers.get("x-razorpay-event-id"), body);
  if (!ev) return NextResponse.json({ ok: true, ignored: true });
  if (!ev.tenantId) return NextResponse.json({ ok: true, ignored: "no tenant" });
  const { error } = await createServiceClient().rpc("apply_billing_event", {
    p_event_id: ev.eventId, p_type: ev.type, p_tenant: ev.tenantId, p_plan: ev.planKey,
    p_interval: ev.interval, p_razorpay_sub: ev.subscriptionId, p_period_end: ev.periodEnd,
  });
  // 500 makes Razorpay retry; the RPC is idempotent so retries are safe.
  if (error) return NextResponse.json({ error: "failed" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
