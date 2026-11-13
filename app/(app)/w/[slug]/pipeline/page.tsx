import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/rules/permissions";
import { getWorkspace } from "@/lib/workspace";
import { Badge, Hidden, Notice } from "@/components/ui";
import { inr, one } from "@/lib/util";
import { CustomFields } from "@/components/custom-fields";
import { archiveRecord, createOpportunity, moveOpportunity } from "../actions";

export const metadata: Metadata = { title: "Pipeline" };

export default async function Pipeline({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant, perms } = await getWorkspace(slug);
  const supabase = await createClient();
  const { data: pipes } = await supabase.from("pipelines").select("id, name").eq("tenant_id", tenant.id).order("created_at");
  const pipe = (pipes ?? []).find((p) => p.id === sp.pipeline) ?? (pipes ?? [])[0];
  const [{ data: stages }, { data: opps }, { data: accounts }] = await Promise.all([
    supabase.from("stages").select("id, name, kind, probability, position").eq("pipeline_id", pipe?.id ?? "").order("position"),
    supabase.from("opportunities").select("id, name, amount, stage_id, expected_close, next_action, next_action_due, status, accounts(name)")
      .eq("tenant_id", tenant.id).eq("pipeline_id", pipe?.id ?? "").is("archived_at", null).order("created_at", { ascending: false }).limit(500),
    supabase.from("accounts").select("id, name").eq("tenant_id", tenant.id).is("archived_at", null).order("name").limit(500),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const weighted = (opps ?? []).filter((o) => o.status === "open").reduce((sum, o) => sum + Number(o.amount) * ((stages ?? []).find((s) => s.id === o.stage_id)?.probability ?? 0) / 100, 0);
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h1 className="text-2xl font-semibold">{pipe?.name ?? "Pipeline"}</h1>
        <p className="text-sm text-muted">Weighted open pipeline: <strong>{inr(weighted)}</strong></p></div>
      <Notice error={sp.error} ok={sp.ok} />
      <nav aria-label="Pipelines" className="flex flex-wrap items-center gap-2">
        {(pipes ?? []).map((p) => <a key={p.id} href={`?pipeline=${p.id}`} aria-current={p.id === pipe?.id ? "page" : undefined}
          className={`rounded px-3 py-1.5 text-sm ${p.id === pipe?.id ? "bg-accent text-white" : "border border-line bg-surface"}`}>{p.name}</a>)}
        {can(perms, "pipeline.configure") && <a className="text-sm text-accent underline" href={`/w/${slug}/pipeline/settings`}>Pipeline settings</a>}
      </nav>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {(stages ?? []).map((st) => {
          const col = (opps ?? []).filter((o) => o.stage_id === st.id);
          return (
            <div key={st.id} className="w-72 shrink-0 rounded-lg border border-line bg-canvas p-3" aria-label={st.name}>
              <h2 className="mb-2 flex justify-between text-sm font-semibold">{st.name}<span className="text-muted">{col.length} · {inr(col.reduce((s, o) => s + Number(o.amount), 0))}</span></h2>
              <ul className="space-y-2">{col.map((o) => (
                <li key={o.id} className="card space-y-2 p-3 text-sm">
                  <p className="font-medium">{o.name}</p>
                  <p className="text-muted">{one(o.accounts as { name: string } | { name: string }[] | null)?.name ?? "No account"} · {inr(o.amount)}{o.expected_close ? ` · closes ${o.expected_close}` : ""}</p>
                  {o.status === "open" && (o.next_action
                    ? <p>Next: {o.next_action} {o.next_action_due && <Badge tone={o.next_action_due < today ? "red" : "grey"}>{o.next_action_due}</Badge>}</p>
                    : <Badge tone="amber">No next action</Badge>)}
                  <form action={moveOpportunity} className="space-y-1">
                    <Hidden name="slug" value={slug} /><Hidden name="id" value={o.id} />
                    <select name="stage" defaultValue={o.stage_id} className="input" aria-label={`Move ${o.name}`}>{(stages ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
                    <input className="input" name="loss_reason" placeholder="Reason (required for Lost)" aria-label="Loss reason" />
                    <button className="btn-quiet w-full">Move</button>
                  </form>
                  <details className="text-xs"><summary className="cursor-pointer text-muted">Custom fields</summary><CustomFields slug={slug} tenantId={tenant.id} entity="opportunities" id={o.id} back={`/w/${slug}/pipeline`} /></details>
                  {o.status !== "open" && <form action={archiveRecord}><Hidden name="slug" value={slug} /><Hidden name="table" value="opportunities" /><Hidden name="id" value={o.id} /><button className="text-xs text-muted underline">Archive</button></form>}
                </li>))}
              </ul>
            </div>);
        })}
      </div>
      <form action={createOpportunity} className="card flex flex-wrap items-end gap-3">
        <Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} /><Hidden name="pipeline" value={pipe?.id ?? ""} />
        <label className="text-sm font-medium">Opportunity<input className="input mt-1" name="name" required /></label>
        <label className="text-sm font-medium">Account<select className="input mt-1" name="account_id"><option value="">None</option>{(accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label className="text-sm font-medium">Value (₹)<input className="input mt-1 w-32" type="number" min="0" name="amount" /></label>
        <label className="text-sm font-medium">Expected close<input className="input mt-1" type="date" name="expected_close" /></label>
        <label className="text-sm font-medium">Next action<input className="input mt-1" name="next_action" /></label>
        <label className="text-sm font-medium">Due<input className="input mt-1" type="date" name="next_action_due" /></label>
        <button className="btn">Create</button>
      </form>
    </section>
  );
}
