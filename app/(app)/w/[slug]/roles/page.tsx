import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ALL_PERMISSIONS, PERMISSIONS, can } from "@/lib/rules/permissions";
import { getWorkspace } from "@/lib/workspace";
import { deleteRole, saveRole } from "./actions";

export const metadata: Metadata = { title: "Roles" };

export default async function Roles({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string }> }) {
  const { slug } = await params;
  const { error } = await searchParams;
  const { tenant, perms } = await getWorkspace(slug);
  const supabase = await createClient();
  const { data: roles } = await supabase.from("roles").select("id, key, name, permissions, is_system").eq("tenant_id", tenant.id).order("is_system", { ascending: false }).order("name");
  const edit = can(perms, "roles.manage");
  const hidden = (n: string, v: string) => <input type="hidden" name={n} value={v} />;
  const matrix = (held: string[], locked: boolean) => (
    <fieldset disabled={locked} className="grid gap-1 sm:grid-cols-2">
      <legend className="sr-only">Permissions</legend>
      {ALL_PERMISSIONS.map((p) => (
        <label key={p} className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="perm" value={p} defaultChecked={held.includes(p)} disabled={locked || !perms.includes(p)} className="mt-1" />
          <span>{PERMISSIONS[p]}<span className="block text-xs text-muted">{p}</span></span>
        </label>
      ))}
    </fieldset>
  );
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Roles</h1>
      {error && <p role="alert" className="rounded border border-line bg-surface p-3 text-sm text-red-700">{error}</p>}
      {(roles ?? []).map((r) => (
        <form key={r.id} action={saveRole} className="card space-y-3">
          {hidden("slug", slug)}{hidden("tenant", tenant.id)}{hidden("id", r.id)}{hidden("key", r.key)}
          <div className="flex items-center justify-between gap-3">
            {r.is_system || !edit ? <h2 className="font-semibold">{r.name}{r.is_system ? " · built in" : ""}</h2>
              : <input className="input max-w-xs" name="name" defaultValue={r.name} aria-label="Role name" required />}
            {edit && !r.is_system && (
              <div className="flex gap-2">
                <button className="btn">Save</button>
                <button className="btn-quiet" formAction={deleteRole}>Delete</button>
              </div>
            )}
          </div>
          {r.is_system && hidden("name", r.name)}
          {matrix(r.permissions as string[], r.is_system || !edit)}
        </form>
      ))}
      {edit && (
        <form action={saveRole} className="card space-y-3">
          {hidden("slug", slug)}{hidden("tenant", tenant.id)}{hidden("id", "")}
          <h2 className="font-semibold">New role</h2>
          <div className="flex flex-wrap gap-3">
            <label className="text-sm font-medium">Name<input className="input mt-1" name="name" required /></label>
            <label className="text-sm font-medium">Key<input className="input mt-1" name="key" required pattern="[a-z][a-z0-9_]{1,30}" placeholder="sales_lead" /></label>
          </div>
          {matrix([], false)}
          <button className="btn">Create role</button>
        </form>
      )}
    </section>
  );
}
