import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getWorkspace } from "@/lib/workspace";
import { Badge, Empty, Hidden, Notice } from "@/components/ui";
import { confirmMerge } from "./actions";

export const metadata: Metadata = { title: "Duplicates" };
const UUID = /^[0-9a-f-]{36}$/i;

export default async function Merge({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant } = await getWorkspace(slug);
  const entity = sp.entity === "contacts" ? "contacts" : "accounts";
  const supabase = await createClient();
  const review = sp.keep && sp.remove && UUID.test(sp.keep) && UUID.test(sp.remove);
  const [{ data: pairs }, prev] = await Promise.all([
    supabase.rpc("find_duplicates", { p_tenant: tenant.id, p_entity: entity }),
    review ? supabase.rpc("preview_merge", { p_entity: entity, p_keep: sp.keep, p_remove: sp.remove }) : Promise.resolve({ data: null, error: null }),
  ]);
  const fields = (prev.data ?? []) as { field: string; keep: unknown; remove: unknown; conflict: boolean; filled_from_removed: boolean }[];
  const show = (v: unknown) => (v === null || v === undefined ? "—" : String(v));
  return (
    <section className="space-y-5">
      <h1 className="text-2xl font-semibold">Duplicates</h1>
      <Notice error={sp.error ?? (prev.error ? "That pair can't be previewed." : undefined)} ok={sp.ok} />
      <nav aria-label="Record type" className="flex gap-2">{["accounts", "contacts"].map((e) => <a key={e} href={`?entity=${e}`} aria-current={e === entity ? "page" : undefined}
        className={`rounded px-3 py-1.5 text-sm ${e === entity ? "bg-accent text-white" : "border border-line bg-surface"}`}>{e[0]!.toUpperCase() + e.slice(1)}</a>)}</nav>
      {review && fields.length > 0 && (
        <div className="card space-y-3">
          <h2 className="font-semibold">Review merge</h2>
          <p className="text-sm text-muted">The left record survives. Empty fields are filled from the right record; where both have different values the left value is kept. Links, deals and activities move to the survivor and the right record is archived. This is recorded in the audit trail.</p>
          <table className="w-full text-left text-sm"><thead className="text-muted"><tr><th className="p-2">Field</th><th className="p-2">Keep</th><th className="p-2">Merge in</th><th className="p-2" /></tr></thead>
            <tbody>{fields.map((f) => <tr key={f.field} className="border-t border-line"><td className="p-2">{f.field}</td><td className="p-2">{show(f.keep)}</td><td className="p-2">{show(f.remove)}</td>
              <td className="p-2">{f.conflict ? <Badge tone="amber">conflict: keeps left</Badge> : f.filled_from_removed ? <Badge tone="blue">filled</Badge> : null}</td></tr>)}</tbody></table>
          <div className="flex gap-3">
            <form action={confirmMerge}><Hidden name="slug" value={slug} /><Hidden name="entity" value={entity} /><Hidden name="keep" value={sp.keep!} /><Hidden name="remove" value={sp.remove!} /><button className="btn">Merge</button></form>
            <a className="btn-quiet" href={`?entity=${entity}&keep=${sp.remove}&remove=${sp.keep}`}>Swap which one survives</a>
            <a className="btn-quiet" href={`?entity=${entity}`}>Cancel</a></div>
        </div>)}
      {(pairs ?? []).length === 0 ? <Empty>No likely duplicates among the {entity} you can see.</Empty> : (
        <ul className="space-y-2">{(pairs as { a_id: string; a_label: string; b_id: string; b_label: string; reason: string }[]).map((p) => (
          <li key={`${p.a_id}${p.b_id}`} className="card flex flex-wrap items-center justify-between gap-2 text-sm">
            <span><span className="font-medium">{p.a_label}</span> ↔ <span className="font-medium">{p.b_label}</span> <Badge>{p.reason}</Badge></span>
            <a className="btn-quiet" href={`?entity=${entity}&keep=${p.a_id}&remove=${p.b_id}`}>Review merge</a></li>))}</ul>)}
    </section>
  );
}
