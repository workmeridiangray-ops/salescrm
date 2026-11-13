import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/rules/permissions";
import { getWorkspace } from "@/lib/workspace";
import { Badge, Hidden, Notice } from "@/components/ui";
import { cancelClosure, grantSupport, requestClosure, rename, revokeSupport } from "./actions";

export const metadata: Metadata = { title: "Workspace settings" };

export default async function Settings({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant, perms, role } = await getWorkspace(slug);
  const supabase = await createClient();
  const configure = can(perms, "tenant.configure");
  const [{ data: t }, { data: grants }] = await Promise.all([
    supabase.from("tenants").select("closure_requested_at").eq("id", tenant.id).maybeSingle(),
    configure ? supabase.from("support_grants").select("id, note, expires_at, revoked_at, created_at").eq("tenant_id", tenant.id).order("created_at", { ascending: false }).limit(10) : Promise.resolve({ data: [] }),
  ]);
  const hid = <><Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} /></>;
  const now = Date.now();
  const purgeOn = t?.closure_requested_at ? new Date(new Date(t.closure_requested_at).getTime() + 30 * 86400000) : null;
  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">Workspace settings</h1>
      <Notice error={sp.error} ok={sp.ok} />
      {configure && (
        <form action={rename} className="card flex flex-wrap items-end gap-3">{hid}
          <label className="text-sm font-medium">Workspace name<input className="input mt-1" name="name" defaultValue={tenant.name} required minLength={2} maxLength={80} /></label><button className="btn-quiet">Rename</button></form>)}
      {configure && (
        <div className="card space-y-3"><h2 className="font-semibold">Support access</h2>
          <p className="text-sm text-muted">By default the vendor's support team cannot see anything about your workspace. You can allow a time-limited look at counts and recent activity (never your records). Each look is written to your audit trail.</p>
          <form action={grantSupport} className="flex flex-wrap items-end gap-3">{hid}
            <label className="text-sm font-medium">Reason<input className="input mt-1 w-72" name="note" required maxLength={300} /></label>
            <label className="text-sm font-medium">For<select className="input mt-1" name="hours"><option value="4">4 hours</option><option value="24">24 hours</option><option value="72">3 days</option></select></label>
            <button className="btn-quiet">Allow</button></form>
          <ul className="space-y-1 text-sm">{(grants ?? []).map((g) => { const live = !g.revoked_at && new Date(g.expires_at).getTime() > now; return (
            <li key={g.id} className="flex items-center gap-2"><Badge tone={live ? "amber" : "grey"}>{live ? "active" : g.revoked_at ? "revoked" : "expired"}</Badge><span>{g.note}</span><span className="text-muted">until {new Date(g.expires_at).toLocaleString("en-IN")}</span>
              {live && <form action={revokeSupport}>{hid}<Hidden name="id" value={g.id} /><button className="text-xs underline">Revoke now</button></form>}</li>); })}</ul>
        </div>)}
      {role.key === "owner" && (
        <div className="card space-y-3 border-red-200"><h2 className="font-semibold">Close this workspace</h2>
          {purgeOn ? (<>
            <p role="status" className="text-sm text-red-800">Closure requested. Everything will be permanently deleted on <strong>{purgeOn.toLocaleDateString("en-IN")}</strong>. Until then you can still use the workspace and export your data from <a className="underline" href={`/w/${slug}/data`}>Import / export</a>.</p>
            <form action={cancelClosure}>{hid}<button className="btn">Cancel closure</button></form></>) : (<>
            <p className="text-sm text-muted">Starts a 30-day countdown. During that time you can export your data or cancel. After it, all records are permanently deleted; the audit trail of the closure is kept. Cancel any subscription in Billing separately.</p>
            <form action={requestClosure} className="flex flex-wrap items-end gap-3">{hid}
              <label className="text-sm font-medium">Type <code>{slug}</code> to confirm<input className="input mt-1" name="confirm" required autoComplete="off" /></label><button className="btn-quiet">Schedule closure</button></form></>)}
        </div>)}
    </section>
  );
}
