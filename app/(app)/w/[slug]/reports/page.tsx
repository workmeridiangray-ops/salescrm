import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/rules/permissions";
import { REPORTS, enrich, formatCell, parseRange, reportByKey } from "@/lib/reports";
import { getWorkspace } from "@/lib/workspace";
import { Empty, Hidden, Notice } from "@/components/ui";
import { one } from "@/lib/util";
import { deleteView, saveView } from "./actions";

export const metadata: Metadata = { title: "Reports" };

export default async function Reports({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant, perms } = await getWorkspace(slug);
  const def = reportByKey(sp.report);
  const range = parseRange(sp.from, sp.to);
  const supabase = await createClient();
  const args = def.ranged ? { p_tenant: tenant.id, p_from: range.from, p_to: range.to } : { p_tenant: tenant.id };
  const [{ data, error }, { data: members }, { data: views }] = await Promise.all([
    supabase.rpc(def.fn, args),
    supabase.from("memberships").select("user_id, profiles(email, full_name)").eq("tenant_id", tenant.id),
    supabase.from("saved_views").select("id, name, report, params, shared, user_id").eq("tenant_id", tenant.id).order("name"),
  ]);
  const people = new Map((members ?? []).map((m) => { const p = one(m.profiles as { email: string; full_name: string } | { email: string; full_name: string }[] | null); return [m.user_id, p?.full_name || p?.email || m.user_id.slice(0, 8)] as const; }));
  const rows = enrich(def.key, (data ?? []) as Record<string, any>[]);
  const exportHref = `/w/${slug}/reports/export?report=${def.key}&from=${range.from}&to=${range.to}`;
  return (
    <section className="space-y-5">
      <h1 className="text-2xl font-semibold">Reports</h1>
      <Notice error={sp.error ?? (error ? "This report couldn't be loaded." : undefined)} />
      <nav aria-label="Reports" className="flex flex-wrap gap-2">
        {REPORTS.map((r) => <a key={r.key} href={`?report=${r.key}&from=${range.from}&to=${range.to}`} aria-current={r.key === def.key ? "page" : undefined}
          className={`rounded px-3 py-1.5 text-sm ${r.key === def.key ? "bg-accent text-white" : "border border-line bg-surface"}`}>{r.title}</a>)}
      </nav>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 className="text-lg font-semibold">{def.title}</h2><p className="text-sm text-muted">{def.note} {can(perms, "crm.read_all") ? "Showing the whole workspace." : "Showing your own records."}</p></div>
        {def.ranged && (
          <form className="flex flex-wrap items-end gap-2"><input type="hidden" name="report" value={def.key} />
            <label className="text-sm font-medium">From<input className="input mt-1" type="date" name="from" defaultValue={range.from} /></label>
            <label className="text-sm font-medium">To<input className="input mt-1" type="date" name="to" defaultValue={range.to} /></label>
            <button className="btn-quiet">Apply</button></form>)}
      </div>
      {rows.length === 0 ? <Empty>Nothing to show for this {def.ranged ? "period" : "report"} yet.</Empty> : (
        <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm">
          <thead className="border-b border-line text-muted"><tr>{def.columns.map((c) => <th key={c.key} className={`p-3 ${c.kind && c.kind !== "text" && c.kind !== "person" ? "text-right" : ""}`}>{c.label}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0">{def.columns.map((c) => <td key={c.key} className={`p-3 ${c.kind && c.kind !== "text" && c.kind !== "person" ? "text-right tabular-nums" : ""}`}>{formatCell(c.kind, r[c.key], people)}</td>)}</tr>))}</tbody></table></div>)}
      <div className="flex flex-wrap items-start gap-4">
        {can(perms, "crm.export") && <a className="btn-quiet" href={exportHref}>Download CSV</a>}
        <form action={saveView} className="flex flex-wrap items-end gap-2">
          <Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} /><Hidden name="report" value={def.key} /><Hidden name="from" value={range.from} /><Hidden name="to" value={range.to} />
          <label className="text-sm font-medium">Save this view as<input className="input mt-1" name="name" required maxLength={80} /></label>
          <label className="text-xs"><input type="checkbox" name="shared" /> share with workspace</label><button className="btn-quiet">Save</button></form>
      </div>
      {(views ?? []).length > 0 && (
        <div><h2 className="text-lg font-semibold">Saved views</h2>
          <ul className="mt-2 space-y-1 text-sm">{(views ?? []).map((v) => { const p = v.params as { from?: string; to?: string }; return (
            <li key={v.id} className="flex items-center gap-3"><a className="text-accent underline" href={`?report=${v.report}&from=${p.from ?? ""}&to=${p.to ?? ""}`}>{v.name}</a>
              <span className="text-muted">{reportByKey(v.report).title}{v.shared ? " · shared" : ""}</span>
              <form action={deleteView}><Hidden name="slug" value={slug} /><Hidden name="id" value={v.id} /><Hidden name="report" value={v.report} /><button className="text-xs text-muted underline">Delete</button></form></li>); })}</ul></div>)}
    </section>
  );
}
