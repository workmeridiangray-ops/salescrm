import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/rules/permissions";
import { getWorkspace } from "@/lib/workspace";
import { Badge, Empty, Hidden, Notice, Pager } from "@/components/ui";
import { CustomFields } from "@/components/custom-fields";
import { PAGE_SIZE, pageOf } from "@/lib/util";
import { convertLead, createLead, disqualifyLead, qualifyLead } from "../actions";

export const metadata: Metadata = { title: "Leads" };
const VIEWS = ["open", "unassigned", "disqualified", "converted"] as const;

export default async function Leads({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant, perms } = await getWorkspace(slug);
  const view = (VIEWS as readonly string[]).includes(sp.view ?? "") ? sp.view! : "open";
  const page = pageOf(sp.page);
  const supabase = await createClient();
  let query = supabase.from("leads").select("id, name, email, company, source, status, score, score_reasons, owner_id, disqualify_reason, created_at")
    .eq("tenant_id", tenant.id).order("score", { ascending: false }).order("created_at", { ascending: false }).range((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  query = view === "open" ? query.in("status", ["new", "qualified"]) : view === "unassigned" ? query.is("owner_id", null).in("status", ["new", "qualified"]) : query.eq("status", view);
  const { data } = await query;
  const rows = (data ?? []).slice(0, PAGE_SIZE);
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Lead inbox</h1>
      <Notice error={sp.error} ok={sp.ok} />
      <nav aria-label="Lead views" className="flex flex-wrap gap-2">
        {VIEWS.filter((v) => v !== "unassigned" || can(perms, "crm.read_all")).map((v) => (
          <a key={v} href={`/w/${slug}/leads?view=${v}`} aria-current={v === view ? "page" : undefined}
            className={`rounded px-3 py-1.5 text-sm ${v === view ? "bg-accent text-white" : "border border-line bg-surface"}`}>{v[0]!.toUpperCase() + v.slice(1)}</a>
        ))}
      </nav>
      {rows.length === 0 ? <Empty>No leads here. Share your <a className="text-accent underline" href={`/capture/${slug}`}>web form</a> or add one below.</Empty> : (
        <ul className="space-y-2">
          {rows.map((l) => (
            <li key={l.id} className="card space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{l.name} {l.company && <span className="text-muted">· {l.company}</span>}</p>
                  <p className="text-sm text-muted">{l.email ?? "no email"} · {l.source}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={l.score >= 60 ? "green" : l.score >= 30 ? "amber" : "grey"}>Score {l.score}</Badge>
                  <Badge tone={l.status === "converted" ? "blue" : l.status === "disqualified" ? "red" : "grey"}>{l.status}</Badge>
                </div>
              </div>
              <details className="text-sm text-muted"><summary className="cursor-pointer">Why this score</summary>
                <ul className="mt-1 list-disc pl-5">{(l.score_reasons as { points: number; reason: string }[]).map((r) => <li key={r.reason}>+{r.points} {r.reason}</li>)}</ul>
              </details>
              {l.status === "disqualified" && <p className="text-sm">Reason: {l.disqualify_reason}</p>}
              <details className="text-sm"><summary className="cursor-pointer text-muted">Custom fields</summary><CustomFields slug={slug} tenantId={tenant.id} entity="leads" id={l.id} back={`/w/${slug}/leads`} /></details>
              {(l.status === "new" || l.status === "qualified") && (
                <div className="flex flex-wrap items-end gap-2">
                  {l.status === "new" && <form action={qualifyLead}><Hidden name="slug" value={slug} /><Hidden name="id" value={l.id} /><button className="btn-quiet">Qualify</button></form>}
                  <form action={convertLead} className="flex gap-2"><Hidden name="slug" value={slug} /><Hidden name="id" value={l.id} />
                    <input className="input w-32" type="number" min="0" name="amount" placeholder="Value ₹" aria-label="Expected value" />
                    <button className="btn">Convert</button></form>
                  <form action={disqualifyLead} className="flex flex-wrap items-center gap-2"><Hidden name="slug" value={slug} /><Hidden name="id" value={l.id} />
                    <input className="input w-48" name="reason" placeholder="Reason" required aria-label="Disqualify reason" />
                    <label className="text-xs"><input type="checkbox" name="can_return" /> may return</label>
                    <button className="btn-quiet">Disqualify</button></form>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Pager base={`/w/${slug}/leads?view=${view}`} page={page} more={(data ?? []).length > PAGE_SIZE} />
      <form action={createLead} className="card grid gap-3 sm:grid-cols-2">
        <Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} />
        <h2 className="font-semibold sm:col-span-2">Add a lead</h2>
        <label className="text-sm font-medium">Name<input className="input mt-1" name="name" required /></label>
        <label className="text-sm font-medium">Email<input className="input mt-1" type="email" name="email" /></label>
        <label className="text-sm font-medium">Company<input className="input mt-1" name="company" /></label>
        <label className="text-sm font-medium">Phone<input className="input mt-1" name="phone" /></label>
        <label className="text-sm font-medium">Source
          <select className="input mt-1" name="source"><option value="manual">Manual</option><option value="referral">Referral</option></select></label>
        <div className="sm:col-span-2"><button className="btn">Add lead</button></div>
      </form>
    </section>
  );
}
