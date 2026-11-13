import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { requirePermission } from "@/lib/workspace";
import { Badge, Empty, Hidden, Notice } from "@/components/ui";
import { createField, toggleField } from "./actions";

export const metadata: Metadata = { title: "Custom fields" };

export default async function Fields({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant } = await requirePermission(slug, "tenant.configure");
  const { data } = await (await createClient()).from("custom_field_defs").select("id, entity, key, label, type, options, required, active").eq("tenant_id", tenant.id).order("entity").order("created_at");
  const hid = <><Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} /></>;
  return (
    <section className="space-y-5">
      <h1 className="text-2xl font-semibold">Custom fields</h1>
      <Notice error={sp.error} ok={sp.ok} />
      <p className="text-sm text-muted">Add the extra details your team needs, up to 20 per record type. Fields can be hidden but never lose their data. They are editable on the account and contact pages, inside lead cards and inside pipeline cards.</p>
      {(data ?? []).length === 0 ? <Empty>No custom fields yet.</Empty> : (
        <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm"><thead className="border-b border-line text-muted"><tr><th className="p-3">Record</th><th className="p-3">Label</th><th className="p-3">Type</th><th className="p-3">Rules</th><th className="p-3" /></tr></thead>
          <tbody>{(data ?? []).map((d) => (
            <tr key={d.id} className="border-b border-line last:border-0"><td className="p-3">{d.entity}</td><td className="p-3 font-medium">{d.label} <span className="font-mono text-xs text-muted">{d.key}</span></td>
              <td className="p-3">{d.type}{d.type === "select" ? ` (${(d.options as string[]).join(", ")})` : ""}</td><td className="p-3">{d.required && <Badge tone="amber">required</Badge>} {!d.active && <Badge>hidden</Badge>}</td>
              <td className="p-3"><form action={toggleField}>{hid}<Hidden name="id" value={d.id} /><Hidden name="active" value={String(!d.active)} /><button className="btn-quiet">{d.active ? "Hide" : "Show"}</button></form></td></tr>))}</tbody></table></div>)}
      <form action={createField} className="card grid gap-3 sm:grid-cols-3">{hid}
        <label className="text-sm font-medium">Record<select className="input mt-1" name="entity"><option value="accounts">Accounts</option><option value="contacts">Contacts</option><option value="leads">Leads</option><option value="opportunities">Opportunities</option></select></label>
        <label className="text-sm font-medium">Label<input className="input mt-1" name="label" required maxLength={60} /></label>
        <label className="text-sm font-medium">Key<input className="input mt-1" name="key" required pattern="[a-z][a-z0-9_]{1,30}" placeholder="employee_count" /></label>
        <label className="text-sm font-medium">Type<select className="input mt-1" name="type"><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="select">Choice</option><option value="checkbox">Yes / no</option></select></label>
        <label className="text-sm font-medium">Choices (comma-separated, for Choice)<input className="input mt-1" name="options" /></label>
        <label className="self-end text-sm"><input type="checkbox" name="required" /> Required</label>
        <div className="sm:col-span-3"><button className="btn">Add field</button></div>
      </form>
    </section>
  );
}
