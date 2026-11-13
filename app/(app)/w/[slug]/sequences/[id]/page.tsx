import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/rules/permissions";
import { requirePermission } from "@/lib/workspace";
import { Badge, Empty, Hidden, Notice } from "@/components/ui";
import { one } from "@/lib/util";
import { addStep, enrol, removeLastStep, saveSettings, setStatus, stopOne } from "../actions";

export const metadata: Metadata = { title: "Sequence" };
const UUID = /^[0-9a-f-]{36}$/i;

export default async function SequenceDetail({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug, id } = await params;
  const sp = await searchParams;
  const { tenant, perms } = await requirePermission(slug, "sequences.manage");
  if (!UUID.test(id)) notFound();
  const supabase = await createClient();
  const { data: seq } = await supabase.from("sequences").select("*").eq("id", id).eq("tenant_id", tenant.id).maybeSingle();
  if (!seq) notFound();
  const pick = sp.pick ? sp.pick.split(",").filter((x) => UUID.test(x)) : [];
  const [{ data: steps }, { data: enrols }, { data: stats }, { data: contacts }, preview] = await Promise.all([
    supabase.from("sequence_steps").select("id, position, kind, delay_days, subject, body").eq("sequence_id", id).order("position"),
    supabase.from("enrolments").select("id, status, stop_reason, current_step, next_step_at, contacts(id, full_name, email)").eq("sequence_id", id).order("created_at", { ascending: false }).limit(100),
    supabase.rpc("sequence_stats", { p_sequence: id }),
    supabase.from("contacts").select("id, full_name, email, opted_out").eq("tenant_id", tenant.id).is("archived_at", null).not("email", "is", null).order("full_name").limit(300),
    pick.length ? supabase.rpc("preview_enrolment", { p_sequence: id, p_contacts: pick }) : Promise.resolve({ data: null }),
  ]);
  const draft = seq.status === "draft", approver = can(perms, "sequences.activate");
  const st = (stats ?? {}) as { enrolled?: number; active?: number; completed?: number; stopped?: Record<string, number>; emails_sent?: number; emails_failed?: number };
  const pv = preview.data as { selected: number; eligible: number; no_email: number; opted_out: number; suppressed: number; already_enrolled: number } | null;
  const hid = <><Hidden name="slug" value={slug} /><Hidden name="sequence" value={id} /></>;
  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-2xl font-semibold">{seq.name}</h1>
        <Badge tone={seq.status === "active" ? "green" : seq.status === "paused" ? "amber" : "grey"}>{seq.status}</Badge></div>
      <Notice error={sp.error} ok={sp.ok} />

      <div className="space-y-2"><h2 className="text-lg font-semibold">Steps</h2>
        {(steps ?? []).length === 0 ? <Empty>No steps yet.</Empty> : (
          <ol className="space-y-2">{(steps ?? []).map((s, i) => (
            <li key={s.id} className="card text-sm"><div className="flex items-center gap-2"><span className="font-medium">{i + 1}. {s.kind === "email" ? "Email" : "Call task"}</span><span className="text-muted">{i === 0 ? (s.delay_days ? `after ${s.delay_days} day(s)` : "right away") : `${s.delay_days} day(s) after the previous step`}</span></div>
              <p className="mt-1 font-medium">{s.subject}</p>{s.body && <p className="mt-1 whitespace-pre-wrap text-muted">{s.body}</p>}</li>))}</ol>)}
        {draft && (<>
          <form action={addStep} className="card space-y-3">{hid}<Hidden name="tenant" value={tenant.id} />
            <div className="flex flex-wrap gap-3">
              <label className="text-sm font-medium">Type<select className="input mt-1" name="kind"><option value="email">Email</option><option value="task">Call task</option></select></label>
              <label className="text-sm font-medium">Wait (days)<input className="input mt-1 w-24" type="number" name="delay" min="0" max="60" defaultValue="0" /></label>
              <label className="grow text-sm font-medium">Subject / task<input className="input mt-1" name="subject" required maxLength={200} /></label></div>
            <label className="block text-sm font-medium">Message (plain text; use {"{{first_name}}"} and {"{{company}}"})<textarea className="input mt-1 py-2" name="body" rows={5} maxLength={5000} /></label>
            <div className="flex gap-2"><button className="btn-quiet">Add step</button></div></form>
          {(steps ?? []).length > 0 && <form action={removeLastStep}>{hid}<button className="text-sm underline">Remove last step</button></form>}</>)}
        {!draft && <p className="text-sm text-muted">Steps are locked once a sequence has been activated, so people already in it never see the plan change. To change it, create a new sequence.</p>}
      </div>

      <form action={saveSettings} className="card flex flex-wrap items-end gap-3">{hid}
        <label className="text-sm font-medium">Name<input className="input mt-1" name="name" defaultValue={seq.name} required /></label>
        <label className="text-sm font-medium">Max emails per day<input className="input mt-1 w-28" type="number" name="daily_limit" min="1" max="500" defaultValue={seq.daily_limit} /></label>
        <label className="text-sm font-medium">Send from<input className="input mt-1" type="time" name="window_start" defaultValue={String(seq.window_start).slice(0, 5)} /></label>
        <label className="text-sm font-medium">until<input className="input mt-1" type="time" name="window_end" defaultValue={String(seq.window_end).slice(0, 5)} /></label>
        <span className="text-sm text-muted">{seq.tz}</span><button className="btn-quiet">Save</button></form>

      <div className="card flex flex-wrap items-center gap-3">
        {approver ? (<>
          {seq.status !== "active" && <form action={setStatus}>{hid}<Hidden name="status" value="active" /><button className="btn">{draft ? "Approve and activate" : "Resume"}</button></form>}
          {seq.status === "active" && <form action={setStatus}>{hid}<Hidden name="status" value="paused" /><button className="btn-quiet">Pause</button></form>}</>)
          : <p className="text-sm text-muted">{draft ? "A manager must approve this sequence before it can send." : `Status: ${seq.status}. Only a manager can pause or resume it.`}</p>}
      </div>

      {seq.status === "active" && (
        <div className="space-y-3"><h2 className="text-lg font-semibold">Enrol contacts</h2>
          <form className="card space-y-3"><p className="text-sm text-muted">Pick people, press Preview to see who will and won't receive it, then confirm.</p>
            <div className="max-h-56 overflow-auto rounded border border-line p-2 text-sm">{(contacts ?? []).map((c) => <label key={c.id} className="block"><input type="checkbox" name="pickbox" value={c.id} defaultChecked={pick.includes(c.id)} /> {c.full_name} <span className="text-muted">{c.email}{c.opted_out ? " · opted out" : ""}</span></label>)}</div>
            <PickScript /><button className="btn-quiet" formAction="" formMethod="get">Preview</button></form>
          {pv && (
            <form action={enrol} className="card space-y-2">{hid}{pick.map((c) => <Hidden key={c} name="contact" value={c} />)}
              <p className="text-sm">Of {pv.selected} selected: <strong>{pv.eligible} will be enrolled</strong>. Skipped: {pv.no_email} without email, {pv.opted_out} opted out, {pv.suppressed} on the suppression list, {pv.already_enrolled} already in this sequence (and {pv.selected === 0 ? "none" : "any"} you can't edit).</p>
              <button className="btn" disabled={pv.eligible === 0}>Enrol {pv.eligible} contact(s)</button></form>)}
        </div>)}

      <div className="space-y-2"><h2 className="text-lg font-semibold">Results</h2>
        <dl className="grid gap-3 sm:grid-cols-5">{[["Enrolled", st.enrolled], ["Active", st.active], ["Completed", st.completed], ["Emails sent", st.emails_sent], ["Send failures", st.emails_failed]].map(([k, v]) => <div key={String(k)} className="card"><dt className="text-sm text-muted">{k}</dt><dd className="text-xl font-semibold">{v ?? 0}</dd></div>)}</dl>
        {st.stopped && Object.keys(st.stopped).length > 0 && <p className="text-sm text-muted">Stopped early: {Object.entries(st.stopped).map(([r, n]) => `${n} ${r.replace("_", " ")}`).join(", ")}.</p>}
        {(enrols ?? []).length > 0 && (
          <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm"><thead className="border-b border-line text-muted"><tr><th className="p-3">Contact</th><th className="p-3">Status</th><th className="p-3">Step</th><th className="p-3" /></tr></thead>
            <tbody>{(enrols ?? []).map((e) => { const c = one(e.contacts as { id: string; full_name: string; email: string } | { id: string; full_name: string; email: string }[] | null); return (
              <tr key={e.id} className="border-b border-line last:border-0"><td className="p-3">{c?.full_name}<span className="block text-muted">{c?.email}</span></td>
                <td className="p-3"><Badge tone={e.status === "active" ? "blue" : e.status === "completed" ? "green" : "amber"}>{e.status}{e.stop_reason ? `: ${e.stop_reason.replace("_", " ")}` : ""}</Badge></td>
                <td className="p-3">{e.current_step + 1} of {(steps ?? []).length}</td>
                <td className="p-3">{e.status === "active" && <form action={stopOne}>{hid}<Hidden name="id" value={e.id} /><button className="btn-quiet">Stop</button></form>}</td></tr>); })}</tbody></table></div>)}
        {(enrols ?? []).length === 0 && <Empty>Nobody is enrolled yet.</Empty>}
      </div>
    </section>
  );
}

/** Tiny helper so the GET preview form carries the ticked contacts as ?pick=a,b,c without client-side frameworks. */
function PickScript() {
  return <script dangerouslySetInnerHTML={{ __html: `document.currentScript.closest('form').addEventListener('submit',function(e){var f=e.target;var ids=[].slice.call(f.querySelectorAll('input[name=pickbox]:checked')).map(function(i){return i.value});e.preventDefault();var u=new URL(location.href);u.searchParams.set('pick',ids.join(','));u.searchParams.delete('ok');u.searchParams.delete('error');location.href=u.toString();});` }} />;
}
