import { NextResponse } from "next/server";
import { toCsv } from "@/lib/csv";
import { can } from "@/lib/rules/permissions";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
const SPEC: Record<string, { table: string; cols: string[] }> = {
  accounts: { table: "accounts", cols: ["name", "domain", "industry", "source", "created_at"] },
  contacts: { table: "contacts", cols: ["full_name", "email", "phone", "job_title", "opted_out", "source", "created_at"] },
  leads: { table: "leads", cols: ["name", "email", "company", "phone", "status", "score", "source", "created_at"] },
  opportunities: { table: "opportunities", cols: ["name", "amount", "currency", "status", "expected_close", "kind", "created_at"] },
};

/** Export runs as the signed-in user, so row-level security limits it to what they may see. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string; entity: string }> }) {
  const { slug, entity } = await params;
  const spec = SPEC[entity];
  if (!spec) return NextResponse.json({ error: "unknown entity" }, { status: 404 });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "sign in" }, { status: 401 });
  const { data: tenant } = await supabase.from("tenants").select("id").eq("slug", slug).maybeSingle();
  if (!tenant) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { data: me } = await supabase.from("memberships").select("roles(permissions)").eq("tenant_id", tenant.id).eq("user_id", user.id).maybeSingle();
  const perms = ((Array.isArray(me?.roles) ? me?.roles[0] : me?.roles)?.permissions ?? []) as string[];
  if (!can(perms, "crm.export")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { data, error } = await supabase.from(spec.table).select(spec.cols.join(",")).eq("tenant_id", tenant.id).order("created_at").limit(50_000);
  if (error) return NextResponse.json({ error: "failed" }, { status: 500 });
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  await supabase.rpc("log_export", { p_tenant: tenant.id, p_entity: entity, p_rows: rows.length });
  const body = toCsv([spec.cols, ...rows.map((r) => spec.cols.map((c) => r[c]))]);
  return new NextResponse(body, { headers: {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${slug}-${entity}-${new Date().toISOString().slice(0, 10)}.csv"`,
    "cache-control": "no-store",
  } });
}
