import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { currentUser } from "@/lib/workspace";
import { createWorkspace } from "./actions";

export const metadata: Metadata = { title: "Workspaces" };

export default async function Workspaces({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  await currentUser();
  const supabase = await createClient();
  const { data: mine } = await supabase
    .from("memberships").select("status, tenants(name, slug, status), roles(name)").order("created_at");
  const rows = (mine ?? []).map((m) => ({
    status: m.status as string,
    tenant: (Array.isArray(m.tenants) ? m.tenants[0] : m.tenants) as { name: string; slug: string; status: string } | null,
    role: (Array.isArray(m.roles) ? m.roles[0] : m.roles) as { name: string } | null,
  }));
  return (
    <main className="mx-auto max-w-2xl space-y-8 p-6">
      <section>
        <h1 className="text-2xl font-semibold">Choose a workspace</h1>
        <p className="mt-1 text-muted">Each company's data is separate. Switch here at any time.</p>
        <ul className="mt-4 space-y-2">
          {rows.length === 0 && <li className="card text-muted">You don't belong to a workspace yet. Create one below or open an invitation link.</li>}
          {rows.map((r) => r.tenant && (
            <li key={r.tenant.slug} className="card flex items-center justify-between">
              <div>
                <p className="font-medium">{r.tenant.name}</p>
                <p className="text-sm text-muted">{r.role?.name}{r.status === "suspended" ? " · access suspended" : ""}{r.tenant.status === "suspended" ? " · workspace suspended" : ""}</p>
              </div>
              {r.status === "active" ? <Link className="btn" href={`/w/${r.tenant.slug}`}>Open</Link> : <span className="text-sm text-muted">Unavailable</span>}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="text-lg font-semibold">Create a workspace</h2>
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
        <form action={createWorkspace} className="card mt-3 space-y-3">
          <label className="block text-sm font-medium">Company name
            <input className="input mt-1" name="name" required minLength={2} maxLength={80} placeholder="Acme Distribution" />
          </label>
          <label className="block text-sm font-medium">Address (optional)
            <input className="input mt-1" name="slug" maxLength={40} placeholder="acme-distribution" pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]" />
          </label>
          <button className="btn">Create workspace</button>
        </form>
      </section>
    </main>
  );
}
