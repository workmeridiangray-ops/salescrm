import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { requirePermission } from "@/lib/workspace";

export const metadata: Metadata = { title: "Audit trail" };

export default async function Audit({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { tenant } = await requirePermission(slug, "audit.view");
  const supabase = await createClient();
  const { data: rows } = await supabase
    .from("audit_log").select("id, at, actor_id, action, entity, entity_id, detail")
    .eq("tenant_id", tenant.id).order("id", { ascending: false }).limit(100);
  // audit_log keeps no FK to profiles (history must outlive people), so look names up separately.
  const actorIds = [...new Set((rows ?? []).map((r) => r.actor_id).filter(Boolean))] as string[];
  const { data: people } = actorIds.length ? await supabase.from("profiles").select("id, email").in("id", actorIds) : { data: [] };
  const email = new Map((people ?? []).map((p) => [p.id, p.email]));
  return (
    <section>
      <h1 className="text-2xl font-semibold">Audit trail</h1>
      <p className="mt-1 text-muted">Most recent 100 events. Entries cannot be edited or deleted.</p>
      <div className="card mt-4 overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-muted"><tr><th className="p-3">When</th><th className="p-3">Who</th><th className="p-3">Action</th><th className="p-3">Detail</th></tr></thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0 align-top">
                <td className="whitespace-nowrap p-3">{new Date(r.at).toLocaleString("en-IN")}</td>
                <td className="p-3">{(r.actor_id && email.get(r.actor_id)) || "system"}</td>
                <td className="p-3 font-mono text-xs">{r.action}</td>
                <td className="p-3 font-mono text-xs text-muted">{JSON.stringify(r.detail)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
