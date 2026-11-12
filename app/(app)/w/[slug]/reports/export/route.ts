import { NextResponse } from "next/server";
import { toCsv } from "@/lib/csv";
import { REPORTS, enrich, parseRange, reportByKey } from "@/lib/reports";
import { can } from "@/lib/rules/permissions";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const url = new URL(request.url);
  const def = reportByKey(url.searchParams.get("report") ?? REPORTS[0]!.key);
  const range = parseRange(url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined);
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "sign in" }, { status: 401 });
  const { data: tenant } = await supabase.from("tenants").select("id").eq("slug", slug).maybeSingle();
  if (!tenant) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { data: me } = await supabase.from("memberships").select("roles(permissions)").eq("tenant_id", tenant.id).eq("user_id", user.id).maybeSingle();
  const perms = ((Array.isArray(me?.roles) ? me?.roles[0] : me?.roles)?.permissions ?? []) as string[];
  if (!can(perms, "crm.export")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { data, error } = await supabase.rpc(def.fn, def.ranged ? { p_tenant: tenant.id, p_from: range.from, p_to: range.to } : { p_tenant: tenant.id });
  if (error) return NextResponse.json({ error: "failed" }, { status: 500 });
  const rows = enrich(def.key, (data ?? []) as Record<string, any>[]);
  await supabase.rpc("log_export", { p_tenant: tenant.id, p_entity: `report:${def.key}`, p_rows: rows.length });
  const csv = toCsv([def.columns.map((c) => c.label), ...rows.map((r) => def.columns.map((c) => r[c.key]))]);
  return new NextResponse(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${slug}-${def.key}-${range.from}_${range.to}.csv"`, "cache-control": "no-store" } });
}
