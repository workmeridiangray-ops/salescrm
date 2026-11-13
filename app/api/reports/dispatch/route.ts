import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron";
import { sendEmailDetailed } from "@/lib/email";
import { buildReportEmail } from "@/lib/report-email";
import { enrich, isoDay, reportByKey } from "@/lib/reports";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 60;

type Claimed = { id: string; tenant_id: string; tenant_name: string; report: string; range_days: number; recipients: string[] };

/** Scheduler calls this (hourly is enough). Each due schedule is claimed once; failures are recorded on the schedule. */
export async function POST(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = createServiceClient();
  const { data, error } = await db.rpc("report_schedules_claim", { p_limit: 10 });
  if (error) return NextResponse.json({ error: "claim failed" }, { status: 500 });
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  let sent = 0;
  for (const s of (data ?? []) as Claimed[]) {
    let failure: string | null = null;
    try {
      const def = reportByKey(s.report);
      const to = isoDay(new Date()), from = isoDay(new Date(Date.now() - s.range_days * 86400000));
      const res = await db.rpc(def.fn, def.ranged ? { p_tenant: s.tenant_id, p_from: from, p_to: to } : { p_tenant: s.tenant_id });
      if (res.error) throw new Error("report failed");
      const { data: mem } = await db.from("memberships").select("user_id, profiles(email, full_name)").eq("tenant_id", s.tenant_id);
      const people = new Map((mem ?? []).map((m) => { const p = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles; return [m.user_id, p?.full_name || p?.email || ""] as const; }));
      const { data: slug } = await db.from("tenants").select("slug").eq("id", s.tenant_id).maybeSingle();
      const mail = buildReportEmail(def, enrich(def.key, (res.data ?? []) as Record<string, any>[]), {
        workspace: s.tenant_name, from, to, people, link: `${base}/w/${slug?.slug ?? ""}/reports?report=${def.key}&from=${from}&to=${to}`,
      });
      const results = await Promise.all(s.recipients.map((r) => sendEmailDetailed({ to: r, ...mail })));
      sent += results.filter((r) => r.ok).length;
      const bad = results.find((r) => !r.ok);
      if (bad) failure = `email: ${bad.error}`;
    } catch (e) {
      failure = e instanceof Error ? e.message : "failed";
    }
    if (failure) await db.rpc("report_schedule_result", { p_id: s.id, p_error: failure });
  }
  return NextResponse.json({ schedules: (data ?? []).length, emails_sent: sent });
}
