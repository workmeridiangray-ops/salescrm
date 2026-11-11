import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getWorkspace } from "@/lib/workspace";
import { Badge, Empty } from "@/components/ui";
import { inr, one } from "@/lib/util";

export const metadata: Metadata = { title: "Renewals" };

export default async function Renewals({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { tenant } = await getWorkspace(slug);
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await (await createClient()).from("opportunities")
    .select("id, name, amount, kind, status, expected_close, next_action, stages(name), accounts(name)").eq("tenant_id", tenant.id).in("kind", ["renewal", "expansion"]).is("archived_at", null).order("expected_close").limit(200);
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Renewals and expansion</h1>
      <p className="text-sm text-muted">Created from a won deal's handover. They run through the normal pipeline.</p>
      {(data ?? []).length === 0 ? <Empty>None yet. Start one from a handover.</Empty> : (
        <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm">
          <thead className="border-b border-line text-muted"><tr><th className="p-3">Opportunity</th><th className="p-3">Type</th><th className="p-3">Stage</th><th className="p-3">Due</th><th className="p-3 text-right">Value</th></tr></thead>
          <tbody>{(data ?? []).map((o) => (
            <tr key={o.id} className="border-b border-line last:border-0"><td className="p-3 font-medium">{o.name}<span className="block text-muted">{one(o.accounts as { name: string } | { name: string }[] | null)?.name}</span></td>
              <td className="p-3"><Badge tone={o.kind === "renewal" ? "blue" : "green"}>{o.kind}</Badge></td><td className="p-3">{one(o.stages as { name: string } | { name: string }[] | null)?.name}</td>
              <td className="p-3">{o.expected_close}{o.status === "open" && o.expected_close && o.expected_close < today && <> <Badge tone="red">overdue</Badge></>}</td>
              <td className="p-3 text-right tabular-nums">{inr(o.amount)}</td></tr>))}</tbody></table></div>)}
    </section>
  );
}
