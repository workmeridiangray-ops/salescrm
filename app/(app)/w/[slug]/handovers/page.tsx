import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getWorkspace } from "@/lib/workspace";
import { Badge, Empty } from "@/components/ui";
import { inr, one } from "@/lib/util";

export const metadata: Metadata = { title: "Handovers" };

export default async function Handovers({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { tenant } = await getWorkspace(slug);
  const { data } = await (await createClient()).from("handovers")
    .select("id, status, escalated_reason, created_at, opportunities(name, amount), handover_items(done_at)").eq("tenant_id", tenant.id).order("created_at", { ascending: false }).limit(100);
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Won-deal handovers</h1>
      <p className="text-sm text-muted">A handover is created automatically when a deal is won.</p>
      {(data ?? []).length === 0 ? <Empty>No won deals yet.</Empty> : (
        <ul className="space-y-2">{(data ?? []).map((h) => {
          const o = one(h.opportunities as { name: string; amount: number } | { name: string; amount: number }[] | null);
          const items = (h.handover_items ?? []) as { done_at: string | null }[];
          return (
            <li key={h.id} className="card flex flex-wrap items-center justify-between gap-2">
              <span><a className="font-medium text-accent underline" href={`/w/${slug}/handovers/${h.id}`}>{o?.name}</a> <span className="text-muted">{o ? inr(o.amount) : ""}</span></span>
              <span className="flex items-center gap-2 text-sm">{items.filter((i) => i.done_at).length}/{items.length} done
                {h.escalated_reason && <Badge tone="red">Escalated</Badge>}
                <Badge tone={h.status === "complete" ? "green" : h.status === "in_progress" ? "blue" : "amber"}>{h.status.replace("_", " ")}</Badge></span>
            </li>); })}</ul>)}
    </section>
  );
}
