import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron";
import { sendEmailDetailed } from "@/lib/email";
import { buildOutreach, oneClickUrl, unsubscribeUrl } from "@/lib/outreach-email";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 60;

type Claimed = { outbound_id: number; to_email: string; subject: string; body: string; unsub_token: string; reply_to: string | null };

/**
 * Scheduler calls this every few minutes. The database decides what is due (window, daily cap, suppression,
 * owner still active); this route only sends what it is handed and reports each result.
 */
export async function POST(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const base = process.env.APP_URL ?? "";
  if (!base) return NextResponse.json({ error: "APP_URL is not set; unsubscribe links would be broken" }, { status: 500 });
  const db = createServiceClient();
  const { data, error } = await db.rpc("sequence_claim_due", { p_limit: 20 });
  if (error) return NextResponse.json({ error: "claim failed" }, { status: 500 });
  const batch = (data ?? []) as Claimed[];
  let delivered = 0;
  for (const m of batch) {   // sequential: gentle on the provider and on sender reputation
    const mail = buildOutreach(m.body, unsubscribeUrl(base, m.unsub_token), undefined, oneClickUrl(base, m.unsub_token));
    const r = await sendEmailDetailed({ to: m.to_email, subject: m.subject, html: mail.html, text: mail.text, headers: mail.headers, replyTo: m.reply_to ?? undefined });
    await db.rpc("sequence_report_send", { p_id: m.outbound_id, p_ok: r.ok, p_message_id: r.messageId, p_error: r.error });
    if (r.ok) delivered++;
  }
  return NextResponse.json({ claimed: batch.length, delivered });
}
