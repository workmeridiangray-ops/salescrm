import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/rules/permissions";
import { requirePermission } from "@/lib/workspace";
import { Badge, Empty, Hidden, Notice } from "@/components/ui";
import { one } from "@/lib/util";
import { addToTeam, createTeam, reassign, removeFromTeam } from "./actions";

export const metadata: Metadata = { title: "Teams" };

export default async function Team({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant, perms } = await requirePermission(slug, "members.view");
  const supabase = await createClient();
  const [{ data: teams }, { data: tm }, { data: members }] = await Promise.all([
    supabase.from("teams").select("id, name").eq("tenant_id", tenant.id).order("name"),
    supabase.from("team_members").select("team_id, user_id, is_lead").eq("tenant_id", tenant.id),
    supabase.from("memberships").select("user_id, status, profiles(email, full_name)").eq("tenant_id", tenant.id).order("created_at"),
  ]);
  const people = (members ?? []).map((m) => { const p = one(m.profiles as { email: string; full_name: string } | { email: string; full_name: string }[] | null); return { id: m.user_id, status: m.status as string, label: p?.full_name || p?.email || m.user_id.slice(0, 8) }; });
  const label = (id: string) => people.find((p) => p.id === id)?.label ?? id.slice(0, 8);
  const manage = can(perms, "members.manage");
  const move = can(perms, "records.reassign");
  const hid = <><Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} /></>;
  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">Teams</h1>
      <Notice error={sp.error} ok={sp.ok} />
      <p className="text-sm text-muted">A team lead can see and work on records owned by people in their team. Everyone else sees only their own records unless their role can see all.</p>
      {(teams ?? []).length === 0 ? <Empty>No teams yet.</Empty> : (
        <div className="grid gap-4 md:grid-cols-2">{(teams ?? []).map((t) => (
          <div key={t.id} className="card space-y-2"><h2 className="font-semibold">{t.name}</h2>
            <ul className="space-y-1 text-sm">{(tm ?? []).filter((x) => x.team_id === t.id).map((x) => (
              <li key={x.user_id} className="flex items-center justify-between">
                <span>{label(x.user_id)} {x.is_lead && <Badge tone="blue">Lead</Badge>}</span>
                {manage && <form action={removeFromTeam}>{hid}<Hidden name="team" value={t.id} /><Hidden name="user" value={x.user_id} /><button className="text-xs text-muted underline">Remove</button></form>}</li>))}</ul>
            {manage && <form action={addToTeam} className="flex flex-wrap items-center gap-2">{hid}<Hidden name="team" value={t.id} />
              <select name="user" className="input w-48" aria-label="Person">{people.filter((p) => p.status === "active").map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
              <label className="text-xs"><input type="checkbox" name="lead" /> lead</label><button className="btn-quiet">Add</button></form>}
          </div>))}</div>)}
      {manage && <form action={createTeam} className="card flex items-end gap-3">{hid}<label className="text-sm font-medium">New team<input className="input mt-1" name="name" required maxLength={80} /></label><button className="btn">Create team</button></form>}
      {move && (
        <form action={reassign} className="card space-y-3">{hid}
          <h2 className="font-semibold">Departures and handovers</h2>
          <p className="text-sm text-muted">Moves open accounts, contacts, leads, opportunities, tasks and unsent quotes. Won and lost deals stay with their owner for history. This is recorded in the audit trail.</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm font-medium">From<select name="from" className="input mt-1">{people.map((p) => <option key={p.id} value={p.id}>{p.label}{p.status === "suspended" ? " (suspended)" : ""}</option>)}</select></label>
            <label className="text-sm font-medium">To<select name="to" className="input mt-1">{people.filter((p) => p.status === "active").map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
            <button className="btn">Reassign everything</button></div>
        </form>)}
    </section>
  );
}
