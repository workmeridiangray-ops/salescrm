import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getWorkspace } from "@/lib/workspace";
import { Badge, Empty, Hidden, Notice } from "@/components/ui";
import { inr, one } from "@/lib/util";
import { CustomFields } from "@/components/custom-fields";
import { addActivity, archiveRecord, createContact } from "../../actions";

export const metadata: Metadata = { title: "Account" };

export default async function AccountDetail({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug, id } = await params;
  const sp = await searchParams;
  const { tenant } = await getWorkspace(slug);
  const supabase = await createClient();
  const { data: account } = await supabase.from("accounts").select("id, name, domain, industry, source, created_at, archived_at").eq("id", id).eq("tenant_id", tenant.id).maybeSingle();
  if (!account) notFound();
  const [{ data: contacts }, { data: opps }, { data: acts }] = await Promise.all([
    supabase.from("contacts").select("id, full_name, email, job_title, opted_out").eq("account_id", id).is("archived_at", null).order("full_name"),
    supabase.from("opportunities").select("id, name, amount, status, stages(name)").eq("account_id", id).is("archived_at", null).order("created_at", { ascending: false }),
    supabase.from("activities").select("id, kind, subject, body, outcome, created_at, done_at").eq("account_id", id).order("created_at", { ascending: false }).limit(50),
  ]);
  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><h1 className="text-2xl font-semibold">{account.name}</h1>
          <p className="text-muted">{[account.domain, account.industry, `source: ${account.source}`].filter(Boolean).join(" · ")}</p></div>
        {!account.archived_at && <form action={archiveRecord}><Hidden name="slug" value={slug} /><Hidden name="table" value="accounts" /><Hidden name="id" value={id} /><button className="btn-quiet">Archive</button></form>}
      </div>
      <Notice error={sp.error} ok={sp.ok} />
      <CustomFields slug={slug} tenantId={tenant.id} entity="accounts" id={id} back={`/w/${slug}/accounts/${id}`} />
      <div><h2 className="text-lg font-semibold">Contacts</h2>
        {(contacts ?? []).length === 0 ? <Empty>No contacts yet.</Empty> : (
          <ul className="mt-2 space-y-2">{(contacts ?? []).map((c) => (
            <li key={c.id} className="card flex justify-between"><span><span className="font-medium">{c.full_name}</span> <span className="text-muted">{c.job_title}</span><br /><span className="text-sm text-muted">{c.email}</span></span>
              {c.opted_out && <Badge tone="red">Opted out</Badge>}</li>))}</ul>)}
        <form action={createContact} className="card mt-3 flex flex-wrap items-end gap-3">
          <Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} /><Hidden name="account_id" value={id} /><Hidden name="back" value={`accounts/${id}`} />
          <label className="text-sm font-medium">Name<input className="input mt-1" name="full_name" required /></label>
          <label className="text-sm font-medium">Email<input className="input mt-1" type="email" name="email" /></label>
          <label className="text-sm font-medium">Title<input className="input mt-1" name="job_title" /></label>
          <button className="btn">Add contact</button>
        </form>
      </div>
      <div><h2 className="text-lg font-semibold">Opportunities</h2>
        {(opps ?? []).length === 0 ? <Empty>None yet. Create one from the pipeline.</Empty> : (
          <ul className="mt-2 space-y-2">{(opps ?? []).map((o) => (
            <li key={o.id} className="card flex justify-between"><span className="font-medium">{o.name}</span>
              <span>{inr(o.amount)} · <Badge tone={o.status === "won" ? "green" : o.status === "lost" ? "red" : "blue"}>{one(o.stages as { name: string } | { name: string }[] | null)?.name}</Badge></span></li>))}</ul>)}
      </div>
      <div><h2 className="text-lg font-semibold">Timeline</h2>
        <form action={addActivity} className="card mt-2 flex flex-wrap items-end gap-3">
          <Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} /><Hidden name="account_id" value={id} /><Hidden name="back" value={`accounts/${id}`} />
          <label className="text-sm font-medium">Type<select className="input mt-1" name="kind"><option value="note">Note</option><option value="call">Call</option><option value="meeting">Meeting</option><option value="task">Task</option></select></label>
          <label className="text-sm font-medium">Subject<input className="input mt-1" name="subject" required /></label>
          <label className="text-sm font-medium">Outcome<input className="input mt-1" name="outcome" /></label>
          <button className="btn">Log</button>
        </form>
        <ul className="mt-3 space-y-2">{(acts ?? []).map((a) => (
          <li key={a.id} className="card text-sm"><Badge>{a.kind}</Badge> <span className="font-medium">{a.subject}</span>{a.outcome && <span className="text-muted"> — {a.outcome}</span>}
            <span className="block text-muted">{new Date(a.created_at).toLocaleString("en-IN")}{a.kind === "task" && !a.done_at ? " · open" : ""}</span></li>))}</ul>
      </div>
    </section>
  );
}
