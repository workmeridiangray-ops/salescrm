import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CustomFields } from "@/components/custom-fields";
import { createClient } from "@/lib/supabase/server";
import { getWorkspace } from "@/lib/workspace";
import { Badge, Empty, Hidden, Notice } from "@/components/ui";
import { one } from "@/lib/util";
import { addActivity } from "../../actions";
import { markReplied } from "../../sequences/actions";

export const metadata: Metadata = { title: "Contact" };
const UUID = /^[0-9a-f-]{36}$/i;

export default async function ContactDetail({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug, id } = await params;
  const sp = await searchParams;
  const { tenant } = await getWorkspace(slug);
  if (!UUID.test(id)) notFound();
  const supabase = await createClient();
  const { data: c } = await supabase.from("contacts").select("id, full_name, email, phone, job_title, opted_out, source, accounts(id, name)").eq("id", id).eq("tenant_id", tenant.id).maybeSingle();
  if (!c) notFound();
  const [{ data: acts }, { data: meets }, { data: enrols }] = await Promise.all([
    supabase.from("activities").select("id, kind, subject, outcome, created_at").eq("contact_id", id).order("created_at", { ascending: false }).limit(50),
    supabase.from("meetings").select("id, title, starts_at, status").eq("contact_id", id).order("starts_at", { ascending: false }).limit(10),
    supabase.from("enrolments").select("id, status, stop_reason, sequences(name)").eq("contact_id", id).order("created_at", { ascending: false }).limit(10),
  ]);
  const acct = one(c.accounts as { id: string; name: string } | { id: string; name: string }[] | null);
  const back = `/w/${slug}/contacts/${id}`;
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-2"><div><h1 className="text-2xl font-semibold">{c.full_name}</h1>
        <p className="text-muted">{[c.job_title, acct?.name, c.email, c.phone].filter(Boolean).join(" · ")}</p></div>
        {c.opted_out ? <Badge tone="red">Opted out of outreach</Badge> : <Badge tone="green">Reachable</Badge>}</div>
      <Notice error={sp.error} ok={sp.ok} />
      <CustomFields slug={slug} tenantId={tenant.id} entity="contacts" id={id} back={back} />
      {(enrols ?? []).length > 0 && (
        <div className="space-y-2"><h2 className="text-lg font-semibold">Sequences</h2>
          <ul className="space-y-1 text-sm">{(enrols ?? []).map((e) => <li key={e.id}>{one(e.sequences as { name: string } | { name: string }[] | null)?.name} <Badge tone={e.status === "active" ? "blue" : "grey"}>{e.status}{e.stop_reason ? `: ${e.stop_reason.replace("_", " ")}` : ""}</Badge></li>)}</ul>
          <form action={markReplied}><Hidden name="slug" value={slug} /><Hidden name="contact" value={id} /><Hidden name="back" value={`contacts/${id}`} /><button className="btn-quiet">They replied — stop outreach</button></form></div>)}
      {(meets ?? []).length > 0 && <div><h2 className="text-lg font-semibold">Meetings</h2><ul className="mt-1 space-y-1 text-sm">{(meets ?? []).map((m) => <li key={m.id}>{m.title} · {new Date(m.starts_at).toLocaleString("en-IN")} <Badge>{m.status.replace("_", " ")}</Badge></li>)}</ul></div>}
      <div><h2 className="text-lg font-semibold">Timeline</h2>
        <form action={addActivity} className="card mt-2 flex flex-wrap items-end gap-3"><Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} /><Hidden name="contact_id" value={id} /><Hidden name="back" value={`contacts/${id}`} />
          <label className="text-sm font-medium">Type<select className="input mt-1" name="kind"><option value="note">Note</option><option value="call">Call</option><option value="meeting">Meeting</option><option value="email">Email</option><option value="task">Task</option></select></label>
          <label className="text-sm font-medium">Subject<input className="input mt-1" name="subject" required /></label>
          <label className="text-sm font-medium">Outcome<input className="input mt-1" name="outcome" /></label><button className="btn">Log</button></form>
        {(acts ?? []).length === 0 ? <div className="mt-3"><Empty>No activity yet.</Empty></div> : (
          <ul className="mt-3 space-y-2">{(acts ?? []).map((a) => <li key={a.id} className="card text-sm"><Badge>{a.kind}</Badge> <span className="font-medium">{a.subject}</span>{a.outcome && <span className="text-muted"> — {a.outcome}</span>}<span className="block text-muted">{new Date(a.created_at).toLocaleString("en-IN")}</span></li>)}</ul>)}</div>
    </section>
  );
}
