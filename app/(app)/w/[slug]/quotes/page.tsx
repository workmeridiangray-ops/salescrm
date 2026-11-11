import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/rules/permissions";
import { QUOTE_STATUS_LABEL, effectiveStatus } from "@/lib/rules/quote";
import { getWorkspace } from "@/lib/workspace";
import { Badge, Empty, Hidden, Notice, Pager } from "@/components/ui";
import { PAGE_SIZE, inr, one, pageOf } from "@/lib/util";
import { createQuote, setThreshold } from "./actions";

export const metadata: Metadata = { title: "Quotes" };
const TONE: Record<string, "grey" | "green" | "red" | "blue" | "amber"> = { accepted: "green", approved: "blue", sent: "blue", pending_approval: "amber", rejected: "red", expired: "red", draft: "grey", superseded: "grey" };

export default async function Quotes({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant, perms } = await getWorkspace(slug);
  const page = pageOf(sp.page);
  const supabase = await createClient();
  const [{ data }, { data: opps }, { data: t }] = await Promise.all([
    supabase.from("quotes").select("id, number, version, status, valid_until, total, created_at, opportunities(name)").eq("tenant_id", tenant.id)
      .order("created_at", { ascending: false }).range((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    supabase.from("opportunities").select("id, name").eq("tenant_id", tenant.id).eq("status", "open").is("archived_at", null).order("name").limit(500),
    supabase.from("tenants").select("discount_approval_pct").eq("id", tenant.id).maybeSingle(),
  ]);
  const rows = (data ?? []).slice(0, PAGE_SIZE);
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Quotes</h1>
      <Notice error={sp.error} ok={sp.ok} />
      <p className="text-sm text-muted">Discounts above {t?.discount_approval_pct ?? 10}% need an approver.</p>
      {rows.length === 0 ? <Empty>No quotes yet. Create one from an open opportunity below.</Empty> : (
        <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm">
          <thead className="border-b border-line text-muted"><tr><th className="p-3">Quote</th><th className="p-3">Opportunity</th><th className="p-3">Status</th><th className="p-3">Valid until</th><th className="p-3 text-right">Total</th></tr></thead>
          <tbody>{rows.map((q) => { const st = effectiveStatus(q.status, q.valid_until); return (
            <tr key={q.id} className="border-b border-line last:border-0">
              <td className="p-3"><a className="font-medium text-accent underline" href={`/w/${slug}/quotes/${q.id}`}>{q.number} v{q.version}</a></td>
              <td className="p-3">{one(q.opportunities as { name: string } | { name: string }[] | null)?.name}</td>
              <td className="p-3"><Badge tone={TONE[st] ?? "grey"}>{QUOTE_STATUS_LABEL[st] ?? st}</Badge></td>
              <td className="p-3">{q.valid_until}</td><td className="p-3 text-right tabular-nums">{inr(q.total)}</td></tr>); })}</tbody></table></div>)}
      <Pager base={`/w/${slug}/quotes`} page={page} more={(data ?? []).length > PAGE_SIZE} />
      <form action={createQuote} className="card flex flex-wrap items-end gap-3">
        <Hidden name="slug" value={slug} />
        <label className="text-sm font-medium">Opportunity<select className="input mt-1" name="opportunity" required>{(opps ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
        <label className="text-sm font-medium">Valid for (days)<input className="input mt-1 w-28" type="number" name="days" min="1" max="365" defaultValue="30" /></label>
        <button className="btn" disabled={(opps ?? []).length === 0}>New quote</button>
      </form>
      {can(perms, "tenant.configure") && (
        <form action={setThreshold} className="card flex flex-wrap items-end gap-3">
          <Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} />
          <label className="text-sm font-medium">Approval needed above discount of (%)<input className="input mt-1 w-28" type="number" step="0.5" min="0" max="100" name="pct" defaultValue={t?.discount_approval_pct ?? 10} /></label>
          <button className="btn-quiet">Save threshold</button>
        </form>)}
    </section>
  );
}
