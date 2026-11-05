import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/rules/permissions";
import { requirePermission } from "@/lib/workspace";
import { changeRole, invite, removeMember, revokeInvitation, setStatus } from "./actions";

export const metadata: Metadata = { title: "Members" };

export default async function Members({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string; invite?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant, perms, user } = await requirePermission(slug, "members.view");
  const supabase = await createClient();
  const [{ data: members }, { data: roles }, { data: invites }] = await Promise.all([
    supabase.from("memberships").select("user_id, status, role_id, profiles(email, full_name)").eq("tenant_id", tenant.id).order("created_at"),
    supabase.from("roles").select("id, key, name, permissions").eq("tenant_id", tenant.id).order("name"),
    supabase.from("invitations").select("id, email, expires_at, status, roles(name)").eq("tenant_id", tenant.id).eq("status", "pending").order("created_at"),
  ]);
  // The database enforces the escalation rules; the UI only offers roles the viewer could grant.
  const grantable = (roles ?? []).filter((r) => (r.permissions as string[]).every((p) => perms.includes(p)));
  const one = <T,>(x: T | T[] | null) => (Array.isArray(x) ? x[0] : x) ?? null;
  const manage = can(perms, "members.manage");
  const hidden = (n: string, v: string) => <input type="hidden" name={n} value={v} />;
  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">Members</h1>
      {sp.error && <p role="alert" className="rounded border border-line bg-surface p-3 text-sm text-red-700">{sp.error}</p>}
      {sp.invite && (
        <p role="status" className="rounded border border-line bg-surface p-3 text-sm">
          Invitation created. Send this link to the person (it is shown only once and works for 7 days):
          <code className="mt-1 block break-all">{`/invite/${sp.invite}`}</code>
        </p>
      )}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-muted"><tr><th className="p-3">Person</th><th className="p-3">Role</th><th className="p-3">Status</th>{manage && <th className="p-3">Actions</th>}</tr></thead>
          <tbody>
            {(members ?? []).map((m) => {
              const p = one(m.profiles as { email: string; full_name: string } | { email: string; full_name: string }[] | null);
              const self = m.user_id === user.id;
              return (
                <tr key={m.user_id} className="border-b border-line last:border-0">
                  <td className="p-3"><p className="font-medium">{p?.full_name || p?.email || "—"}</p><p className="text-muted">{p?.email}</p></td>
                  <td className="p-3">
                    {manage ? (
                      <form action={changeRole} className="flex gap-2">
                        {hidden("slug", slug)}{hidden("tenant", tenant.id)}{hidden("user", m.user_id)}
                        <select name="role" defaultValue={m.role_id} className="input" aria-label={`Role for ${p?.email}`}>
                          {(roles ?? []).map((r) => <option key={r.id} value={r.id} disabled={!grantable.some((g) => g.id === r.id)}>{r.name}</option>)}
                        </select>
                        <button className="btn-quiet">Save</button>
                      </form>
                    ) : (one(roles?.find((r) => r.id === m.role_id) ? [roles!.find((r) => r.id === m.role_id)!] : null)?.name)}
                  </td>
                  <td className="p-3">{m.status === "active" ? "Active" : "Suspended"}{self ? " (you)" : ""}</td>
                  {manage && (
                    <td className="p-3">
                      <div className="flex gap-2">
                        <form action={setStatus}>{hidden("slug", slug)}{hidden("tenant", tenant.id)}{hidden("user", m.user_id)}{hidden("status", m.status === "active" ? "suspended" : "active")}
                          <button className="btn-quiet">{m.status === "active" ? "Suspend" : "Reinstate"}</button></form>
                        <form action={removeMember}>{hidden("slug", slug)}{hidden("tenant", tenant.id)}{hidden("user", m.user_id)}
                          <button className="btn-quiet">Remove</button></form>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {can(perms, "members.invite") && (
        <>
          <form action={invite} className="card flex flex-wrap items-end gap-3">
            {hidden("slug", slug)}{hidden("tenant", tenant.id)}
            <label className="text-sm font-medium">Email<input className="input mt-1" type="email" name="email" required /></label>
            <label className="text-sm font-medium">Role
              <select className="input mt-1" name="role" required>{grantable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
            </label>
            <button className="btn">Invite</button>
          </form>
          <div>
            <h2 className="text-lg font-semibold">Pending invitations</h2>
            {(invites ?? []).length === 0 ? <p className="mt-1 text-muted">None.</p> : (
              <ul className="mt-2 space-y-2">
                {(invites ?? []).map((i) => (
                  <li key={i.id} className="card flex items-center justify-between">
                    <span>{i.email} · {one(i.roles as { name: string } | { name: string }[] | null)?.name} · expires {new Date(i.expires_at).toLocaleDateString("en-IN")}</span>
                    <form action={revokeInvitation}>{hidden("slug", slug)}{hidden("tenant", tenant.id)}{hidden("id", i.id)}<button className="btn-quiet">Revoke</button></form>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
