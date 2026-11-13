import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getWorkspace } from "@/lib/workspace";
import { Badge, Empty, Hidden, Notice } from "@/components/ui";
import { one } from "@/lib/util";
import { createLink, createMeeting, saveAvailability, setOutcome, toggleLink } from "./actions";

export const metadata: Metadata = { title: "Meetings" };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default async function Meetings({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant, user } = await getWorkspace(slug);
  const supabase = await createClient();
  const [{ data: upcoming }, { data: past }, { data: rules }, { data: links }, { data: contacts }] = await Promise.all([
    supabase.from("meetings").select("id, title, starts_at, ends_at, status, attendee_email, source, contacts(full_name)").eq("tenant_id", tenant.id).eq("status", "scheduled").gte("ends_at", new Date().toISOString()).order("starts_at").limit(100),
    supabase.from("meetings").select("id, title, starts_at, status, outcome, contacts(full_name)").eq("tenant_id", tenant.id).or(`status.neq.scheduled,ends_at.lt.${new Date().toISOString()}`).order("starts_at", { ascending: false }).limit(30),
    supabase.from("availability_rules").select("weekday, start_time, end_time").eq("tenant_id", tenant.id).eq("user_id", user.id),
    supabase.from("booking_links").select("id, slug, title, duration_min, active, tz").eq("tenant_id", tenant.id).eq("owner_id", user.id),
    supabase.from("contacts").select("id, full_name").eq("tenant_id", tenant.id).is("archived_at", null).order("full_name").limit(300),
  ]);
  const when = (d: string) => new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  const rule = (d: number) => (rules ?? []).find((r) => r.weekday === d);
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const hid = <><Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} /></>;
  const cname = (c: unknown) => one(c as { full_name: string } | { full_name: string }[] | null)?.full_name;
  return (
    <section className="space-y-8">
      <h1 className="text-2xl font-semibold">Meetings</h1>
      <Notice error={sp.error} ok={sp.ok} />
      <p className="text-sm text-muted">Times are shown in your browser's time zone. Calendar sync with Google or Outlook isn't connected: use "Add to calendar" to download a file, and booking pages respect only the meetings kept here.</p>
      <div className="space-y-2"><h2 className="text-lg font-semibold">Upcoming</h2>
        {(upcoming ?? []).length === 0 ? <Empty>No upcoming meetings.</Empty> : (
          <ul className="space-y-2">{(upcoming ?? []).map((m) => (
            <li key={m.id} className="card flex flex-wrap items-center justify-between gap-2 text-sm">
              <span><span className="font-medium">{m.title}</span> <Badge tone={m.source === "booking" ? "blue" : "grey"}>{m.source}</Badge><br /><span className="text-muted">{when(m.starts_at)}{cname(m.contacts) ? ` · ${cname(m.contacts)}` : ""}{m.attendee_email ? ` · ${m.attendee_email}` : ""}</span></span>
              <span className="flex gap-2"><a className="btn-quiet" href={`/w/${slug}/meetings/ics/${m.id}`}>Add to calendar</a>
                <form action={setOutcome} className="flex gap-2">{hid}<Hidden name="id" value={m.id} /><Hidden name="status" value="cancelled" /><button className="btn-quiet">Cancel</button></form></span></li>))}</ul>)}
        <form action={createMeeting} className="card flex flex-wrap items-end gap-3">{hid}
          <label className="text-sm font-medium">Title<input className="input mt-1" name="title" required maxLength={160} /></label>
          <label className="text-sm font-medium">Starts<input className="input mt-1" type="datetime-local" name="start" required /></label>
          <label className="text-sm font-medium">Length<select className="input mt-1" name="minutes"><option value="15">15 min</option><option value="30" selected>30 min</option><option value="45">45 min</option><option value="60">1 hour</option><option value="90">90 min</option></select></label>
          <label className="text-sm font-medium">Buffer after (min)<input className="input mt-1 w-24" type="number" name="buffer" min="0" max="60" defaultValue="0" /></label>
          <label className="text-sm font-medium">Contact<select className="input mt-1" name="contact"><option value="">—</option>{(contacts ?? []).map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select></label>
          <button className="btn">Schedule</button></form>
      </div>
      <div className="space-y-2"><h2 className="text-lg font-semibold">Outcomes</h2>
        {(past ?? []).length === 0 ? <Empty>Nothing to review.</Empty> : (
          <ul className="space-y-2">{(past ?? []).map((m) => (
            <li key={m.id} className="card flex flex-wrap items-center justify-between gap-2 text-sm"><span><span className="font-medium">{m.title}</span> <span className="text-muted">{when(m.starts_at)}{cname(m.contacts) ? ` · ${cname(m.contacts)}` : ""}</span></span>
              {m.status === "scheduled" ? (
                <form action={setOutcome} className="flex flex-wrap gap-2">{hid}<Hidden name="id" value={m.id} /><input className="input w-56" name="outcome" placeholder="What happened?" aria-label="Outcome" />
                  <button className="btn-quiet" name="status" value="completed">Attended</button><button className="btn-quiet" name="status" value="no_show">No-show</button></form>)
                : <span><Badge tone={m.status === "completed" ? "green" : m.status === "no_show" ? "red" : "grey"}>{m.status.replace("_", " ")}</Badge> {m.outcome}</span>}</li>))}</ul>)}
      </div>
      <form action={saveAvailability} className="card space-y-3">{hid}<h2 className="font-semibold">Your availability for booking pages</h2>
        {DAYS.map((d, i) => <div key={d} className="flex flex-wrap items-center gap-3 text-sm"><label className="w-28"><input type="checkbox" name={`on_${i}`} defaultChecked={!!rule(i)} /> {d}</label>
          <input className="input w-28" type="time" name={`start_${i}`} defaultValue={String(rule(i)?.start_time ?? "09:00").slice(0, 5)} aria-label={`${d} from`} /><span>to</span>
          <input className="input w-28" type="time" name={`end_${i}`} defaultValue={String(rule(i)?.end_time ?? "17:00").slice(0, 5)} aria-label={`${d} until`} /></div>)}
        <button className="btn-quiet">Save availability</button></form>
      <div className="space-y-2"><h2 className="text-lg font-semibold">Booking pages</h2>
        <ul className="space-y-1 text-sm">{(links ?? []).map((l) => (
          <li key={l.id} className="flex flex-wrap items-center gap-2"><a className="text-accent underline" href={`/book/${l.slug}`}>{base}/book/{l.slug}</a><span className="text-muted">{l.title} · {l.duration_min} min · {l.tz}</span>
            <form action={toggleLink}>{hid}<Hidden name="id" value={l.id} /><Hidden name="active" value={String(!l.active)} /><button className="text-xs underline">{l.active ? "Turn off" : "Turn on"}</button></form></li>))}</ul>
        <form action={createLink} className="card flex flex-wrap items-end gap-3">{hid}
          <label className="text-sm font-medium">Address<input className="input mt-1" name="slug_value" required pattern="[a-z0-9][a-z0-9\-]{3,40}" placeholder="acme-intro-call" /></label>
          <label className="text-sm font-medium">Title<input className="input mt-1" name="title" required defaultValue="Intro call" /></label>
          <label className="text-sm font-medium">Length<select className="input mt-1" name="duration"><option value="15">15 min</option><option value="30" selected>30 min</option><option value="45">45 min</option><option value="60">60 min</option></select></label>
          <label className="text-sm font-medium">Buffer (min)<input className="input mt-1 w-24" type="number" name="buffer" min="0" max="60" defaultValue="10" /></label>
          <label className="text-sm font-medium">Min notice (h)<input className="input mt-1 w-24" type="number" name="notice" min="0" max="168" defaultValue="4" /></label>
          <label className="text-sm font-medium">Bookable days ahead<input className="input mt-1 w-24" type="number" name="window" min="1" max="60" defaultValue="14" /></label>
          <label className="text-sm font-medium">Time zone<input className="input mt-1" name="tz" defaultValue="Asia/Kolkata" /></label>
          <button className="btn">Create booking page</button></form></div>
    </section>
  );
}
