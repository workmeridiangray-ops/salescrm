import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { requirePermission } from "@/lib/workspace";
import { Badge, Hidden, Notice } from "@/components/ui";
import { addStage, createPipeline, deleteStage, moveStage, updateStage } from "./actions";

export const metadata: Metadata = { title: "Pipeline settings" };

export default async function PipelineSettings({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant } = await requirePermission(slug, "pipeline.configure");
  const supabase = await createClient();
  const [{ data: pipes }, { data: stages }] = await Promise.all([
    supabase.from("pipelines").select("id, name").eq("tenant_id", tenant.id).order("created_at"),
    supabase.from("stages").select("id, pipeline_id, name, position, probability, kind").eq("tenant_id", tenant.id).order("position"),
  ]);
  const hid = (p: string) => <><Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} /><Hidden name="pipeline" value={p} /></>;
  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">Pipeline settings</h1>
      <Notice error={sp.error} ok={sp.ok} />
      <p className="text-sm text-muted">Win probability drives the forecast. Won and Lost always stay last. A stage that holds deals can't be deleted: move the deals first. Changing a probability affects forecasts from now on, not recorded history.</p>
      {(pipes ?? []).map((p) => {
        const st = (stages ?? []).filter((x) => x.pipeline_id === p.id);
        return (
          <div key={p.id} className="card space-y-3"><h2 className="font-semibold">{p.name}</h2>
            <ul className="space-y-2">{st.map((x) => x.kind === "open" ? (
              <li key={x.id} className="flex flex-wrap items-center gap-2">
                <form action={updateStage} className="flex flex-wrap items-center gap-2">{hid(p.id)}<Hidden name="stage" value={x.id} />
                  <input className="input w-48" name="name" defaultValue={x.name} required aria-label="Stage name" />
                  <input className="input w-24" type="number" min="1" max="99" name="probability" defaultValue={x.probability} required aria-label="Win probability %" /><span className="text-sm text-muted">%</span>
                  <button className="btn-quiet">Save</button></form>
                <form action={moveStage}>{hid(p.id)}<Hidden name="stage" value={x.id} /><Hidden name="dir" value="-1" /><button className="btn-quiet" aria-label={`Move ${x.name} up`}>↑</button></form>
                <form action={moveStage}>{hid(p.id)}<Hidden name="stage" value={x.id} /><Hidden name="dir" value="1" /><button className="btn-quiet" aria-label={`Move ${x.name} down`}>↓</button></form>
                <form action={deleteStage}>{hid(p.id)}<Hidden name="stage" value={x.id} /><button className="btn-quiet">Delete</button></form>
              </li>) : (<li key={x.id} className="flex items-center gap-2 text-sm"><span className="font-medium">{x.name}</span><Badge tone={x.kind === "won" ? "green" : "red"}>{x.kind}</Badge></li>))}</ul>
            <form action={addStage} className="flex flex-wrap items-end gap-2">{hid(p.id)}
              <label className="text-sm font-medium">New stage<input className="input mt-1 w-48" name="name" required /></label>
              <label className="text-sm font-medium">Probability %<input className="input mt-1 w-24" type="number" min="1" max="99" name="probability" required defaultValue="50" /></label>
              <button className="btn-quiet">Add stage</button></form>
          </div>);
      })}
      <form action={createPipeline} className="card flex flex-wrap items-end gap-3">{hid("")}
        <label className="text-sm font-medium">New pipeline<input className="input mt-1" name="name" required maxLength={80} /></label>
        <label className="text-sm font-medium">Template<select className="input mt-1" name="template"><option value="services">Services (Discovery → Proposal → Negotiation)</option><option value="distribution">Distribution (Enquiry → Quote sent → PO expected)</option><option value="blank">Blank (one stage)</option></select></label>
        <button className="btn">Create pipeline</button></form>
    </section>
  );
}
