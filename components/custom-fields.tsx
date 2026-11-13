import { createClient } from "@/lib/supabase/server";
import { Hidden } from "@/components/ui";
import { saveCustomValues } from "@/app/(app)/w/[slug]/fields/actions";

/** Editable custom fields for one record. Renders nothing if the workspace defined none for this type. */
export async function CustomFields({ slug, tenantId, entity, id, back }: { slug: string; tenantId: string; entity: string; id: string; back: string }) {
  const supabase = await createClient();
  const [{ data: defs }, { data: row }] = await Promise.all([
    supabase.from("custom_field_defs").select("key, label, type, options, required").eq("tenant_id", tenantId).eq("entity", entity).eq("active", true).order("created_at"),
    supabase.from(entity).select("custom").eq("id", id).maybeSingle(),
  ]);
  if (!defs || defs.length === 0) return null;
  const values = (row?.custom ?? {}) as Record<string, unknown>;
  return (
    <form action={saveCustomValues} className="card space-y-3">
      <Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenantId} /><Hidden name="entity" value={entity} /><Hidden name="id" value={id} /><Hidden name="back" value={back} />
      <h2 className="font-semibold">Custom fields</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {defs.map((d) => {
          const v = values[d.key];
          const name = `cf_${d.key}`;
          return (
            <label key={d.key} className="block text-sm font-medium">{d.label}{d.required ? " *" : ""}
              {d.type === "select" ? <select className="input mt-1" name={name} defaultValue={String(v ?? "")} required={d.required}><option value="">—</option>{(d.options as string[]).map((o) => <option key={o}>{o}</option>)}</select>
                : d.type === "checkbox" ? <input className="ml-2" type="checkbox" name={name} defaultChecked={v === true} />
                : <input className="input mt-1" name={name} type={d.type === "number" ? "number" : d.type === "date" ? "date" : "text"} step={d.type === "number" ? "any" : undefined} maxLength={500} defaultValue={v === undefined || v === null ? "" : String(v)} required={d.required} />}
            </label>);
        })}
      </div>
      <button className="btn-quiet">Save custom fields</button>
    </form>
  );
}
