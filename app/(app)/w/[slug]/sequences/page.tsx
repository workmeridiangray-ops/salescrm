import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/rules/permissions";
import { requirePermission } from "@/lib/workspace";
import { Badge, Empty, Hidden, Notice } from "@/components/ui";
import { addSuppression, createSequence } from "./actions";

export const metadata: Metadata = { title: "Sequences" };

export default async function Sequences({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant, perms } = await requirePermission(slug, "sequences.manage");
  const supabase = await createClient();
  const approver = can(perms, "sequences.activate");
  const [{ data }, { data: supp }] = await Promise.all([
    supabase.from("sequences").select("id, name, status, daily_limit, created_at").eq("tenant_id", tenant.id).order("created_at", { ascending: false }),
    approver ? supabase.from("email_suppressions").select("email, reason, created_at").eq("tenant_id", tenant.id).order("created_at", { ascending: false }).limit(50) : Promise.resolve({ data: [] }),
  ]);
  return (
    <section className="space-y-5">
      <h1 className="text-2xl font-semibold">Outreach sequences</h1>
      <Notice error={sp.error} ok={sp.ok} />
      <p className="text-sm text-muted">A sequence is a short series of emails and call tasks. A manager approves it before it can send. It stops on its own when the person replies, unsubscribes or is opted out, and every email carries an unsubscribe link. We don't track opens or clicks: they say little about real interest.</p>
      {(data ?? []).length === 0 ? <Empty>No sequences yet.</Empty> : (
        <ul className="space-y-2">{(data ?? []).map((q) => (
          <li key={q.id} className="card flex items-center justify-between"><a className="font-medium text-accent underline" href={`/w/${slug}/sequences/${q.id}`}>{q.name}</a>
            <span className="flex items-center gap-2 text-sm text-muted">up to {q.daily_limit}/day <Badge tone={q.status === "active" ? "green" : q.status === "paused" ? "amber" : "grey"}>{q.status}</Badge></span></li>))}</ul>)}
      <form action={createSequence} className="card flex items-end gap-3"><Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} />
        <label className="text-sm font-medium">New sequence<input className="input mt-1" name="name" required maxLength={100} /></label><button className="btn">Create</button></form>
      {approver && (
        <div className="space-y-2"><h2 className="text-lg font-semibold">Suppression list</h2>
          <p className="text-sm text-muted">Addresses we will never email from sequences. Unsubscribes land here automatically.</p>
          <ul className="space-y-1 text-sm">{(supp ?? []).map((s) => <li key={s.email}><code>{s.email}</code> <Badge>{s.reason}</Badge></li>)}{(supp ?? []).length === 0 && <li className="text-muted">Empty.</li>}</ul>
          <form action={addSuppression} className="flex flex-wrap items-end gap-3"><Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} />
            <label className="text-sm font-medium">Email<input className="input mt-1" type="email" name="email" required /></label>
            <label className="text-sm font-medium">Reason<select className="input mt-1" name="reason"><option value="manual">Do not contact</option><option value="bounced">Bounced</option><option value="complaint">Complained</option></select></label>
            <button className="btn-quiet">Add</button></form></div>)}
    </section>
  );
}
