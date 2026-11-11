import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getWorkspace } from "@/lib/workspace";
import { Badge, Hidden, Notice } from "@/components/ui";
import { inr, one } from "@/lib/util";
import { completeHandover, saveHandover, startRenewal, toggleItem } from "../actions";

export const metadata: Metadata = { title: "Handover" };

export default async function HandoverDetail({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug, id } = await params;
  const sp = await searchParams;
  const { tenant } = await getWorkspace(slug);
  const supabase = await createClient();
  const { data: h } = await supabase.from("handovers").select("*, opportunities(id, name, amount), accounts(name), contacts(full_name, email)").eq("id", id).eq("tenant_id", tenant.id).maybeSingle();
  if (!h) notFound();
  const { data: items } = await supabase.from("handover_items").select("id, label, done_at").eq("handover_id", id).order("position");
  const opp = one(h.opportunities as { id: string; name: string; amount: number } | { id: string; name: string; amount: number }[] | null);
  const acct = one(h.accounts as { name: string } | { name: string }[] | null);
  const contact = one(h.contacts as { full_name: string; email: string | null } | { full_name: string; email: string | null }[] | null);
  const done = h.status === "complete";
  const hid = <><Hidden name="slug" value={slug} /><Hidden name="id" value={id} /></>;
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><h1 className="text-2xl font-semibold">{opp?.name}</h1><p className="text-muted">{[acct?.name, contact && `${contact.full_name}${contact.email ? ` <${contact.email}>` : ""}`, opp && inr(opp.amount)].filter(Boolean).join(" · ")}</p></div>
        <Badge tone={done ? "green" : "blue"}>{h.status.replace("_", " ")}</Badge>
      </div>
      <Notice error={sp.error} ok={sp.ok} />
      <ul className="card space-y-2">{(items ?? []).map((i) => (
        <li key={i.id} className="flex items-center justify-between gap-2 text-sm"><span className={i.done_at ? "text-muted line-through" : ""}>{i.label}</span>
          {!done && <form action={toggleItem}>{hid}<Hidden name="item" value={i.id} /><Hidden name="done" value={String(!i.done_at)} /><button className="btn-quiet">{i.done_at ? "Undo" : "Mark done"}</button></form>}</li>))}</ul>
      <form action={saveHandover} className="card space-y-3">{hid}
        {[["scope", "Scope of work", h.scope], ["commercial_terms", "Commercial terms", h.commercial_terms], ["commitments", "Outstanding commitments", h.commitments]].map(([k, l, v]) => (
          <label key={String(k)} className="block text-sm font-medium">{l}<textarea className="input mt-1 py-2" name={String(k)} rows={3} maxLength={4000} defaultValue={String(v ?? "")} disabled={done} /></label>))}
        <label className="block text-sm font-medium">Renewal date<input className="input mt-1 w-48" type="date" name="renewal_date" defaultValue={h.renewal_date ?? ""} disabled={done} /></label>
        <label className="block text-sm font-medium">Escalation (leave blank if none)<input className="input mt-1" name="escalated_reason" defaultValue={h.escalated_reason ?? ""} disabled={done} /></label>
        {!done && <button className="btn-quiet">Save</button>}
      </form>
      {!done && <form action={completeHandover}>{hid}<button className="btn">Complete handover</button></form>}
      {opp && (
        <form action={startRenewal} className="card flex flex-wrap items-end gap-3">{hid}<Hidden name="opportunity" value={opp.id} />
          <label className="text-sm font-medium">Next opportunity<select className="input mt-1" name="kind"><option value="renewal">Renewal</option><option value="expansion">Expansion</option></select></label>
          <label className="text-sm font-medium">Expected date<input className="input mt-1" type="date" name="date" required defaultValue={h.renewal_date ?? ""} /></label>
          <button className="btn-quiet">Create</button></form>)}
    </section>
  );
}
