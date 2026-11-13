import { lookup } from "node:dns/promises";
import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { isPrivateIp, isSafeWebhookUrl, signPayload } from "@/lib/webhooks";

export const runtime = "nodejs";
export const maxDuration = 60;

type Claimed = { id: number; url: string; secret: string; event: string; payload: unknown; attempts: number };

/** Resolve the host ourselves and refuse private addresses, so a public name can't point inside our network. */
async function resolvesPublic(host: string): Promise<boolean> {
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch { return false; }
}

async function deliver(d: Claimed): Promise<{ ok: boolean; http: number | null; error: string | null }> {
  if (!isSafeWebhookUrl(d.url)) return { ok: false, http: null, error: "blocked: unsafe URL" };
  if (!(await resolvesPublic(new URL(d.url).hostname))) return { ok: false, http: null, error: "blocked: resolves to a non-public address" };
  const body = JSON.stringify(d.payload);
  const ts = Math.floor(Date.now() / 1000);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(d.url, {
      method: "POST", redirect: "manual", signal: ctl.signal,
      headers: {
        "content-type": "application/json", "user-agent": "SalesCRM-Webhooks/1",
        "x-webhook-event": d.event, "x-webhook-delivery": String(d.id), "x-webhook-timestamp": String(ts),
        "x-webhook-signature": signPayload(d.secret, ts, body),
      },
      body,
    });
    return res.status >= 200 && res.status < 300 ? { ok: true, http: res.status, error: null } : { ok: false, http: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, http: null, error: e instanceof Error && e.name === "AbortError" ? "timeout after 5s" : "network error" };
  } finally { clearTimeout(timer); }
}

/** Call every minute from a scheduler with  Authorization: Bearer $CRON_SECRET. */
export async function POST(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = createServiceClient();
  const { data, error } = await db.rpc("webhook_claim_batch", { p_limit: 20 });
  if (error) return NextResponse.json({ error: "claim failed" }, { status: 500 });
  const batch = (data ?? []) as Claimed[];
  const results = await Promise.all(batch.map(async (d) => {
    const r = await deliver(d);
    await db.rpc("webhook_report", { p_id: d.id, p_ok: r.ok, p_http: r.http, p_error: r.error });
    return r.ok;
  }));
  return NextResponse.json({ claimed: batch.length, delivered: results.filter(Boolean).length });
}
