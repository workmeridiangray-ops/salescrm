import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/rules/permissions";
import { getWorkspace } from "@/lib/workspace";
import { Badge, Empty, Hidden, Notice } from "@/components/ui";
import { inr } from "@/lib/util";
import { addProduct, toggleProduct } from "../quotes/actions";

export const metadata: Metadata = { title: "Products" };

export default async function Products({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant, perms } = await getWorkspace(slug);
  const { data } = await (await createClient()).from("products").select("id, sku, name, unit_price, tax_rate, active").eq("tenant_id", tenant.id).order("name").limit(500);
  const manage = can(perms, "products.manage");
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Products</h1>
      <Notice error={sp.error} ok={sp.ok} />
      {(data ?? []).length === 0 ? <Empty>No products yet.{manage ? " Add the first one below." : " A manager can add them."}</Empty> : (
        <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm">
          <thead className="border-b border-line text-muted"><tr><th className="p-3">Name</th><th className="p-3">SKU</th><th className="p-3 text-right">Price</th><th className="p-3 text-right">GST</th><th className="p-3">Status</th>{manage && <th className="p-3" />}</tr></thead>
          <tbody>{(data ?? []).map((p) => (
            <tr key={p.id} className="border-b border-line last:border-0"><td className="p-3 font-medium">{p.name}</td><td className="p-3">{p.sku ?? "—"}</td>
              <td className="p-3 text-right tabular-nums">{inr(p.unit_price)}</td><td className="p-3 text-right tabular-nums">{p.tax_rate}%</td>
              <td className="p-3">{p.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
              {manage && <td className="p-3"><form action={toggleProduct}><Hidden name="slug" value={slug} /><Hidden name="id" value={p.id} /><Hidden name="active" value={String(!p.active)} /><button className="btn-quiet">{p.active ? "Deactivate" : "Activate"}</button></form></td>}</tr>))}</tbody></table></div>)}
      {manage && (
        <form action={addProduct} className="card flex flex-wrap items-end gap-3">
          <Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} />
          <label className="text-sm font-medium">Name<input className="input mt-1" name="name" required /></label>
          <label className="text-sm font-medium">SKU<input className="input mt-1" name="sku" /></label>
          <label className="text-sm font-medium">Price (₹)<input className="input mt-1 w-32" type="number" step="0.01" min="0" name="unit_price" required /></label>
          <label className="text-sm font-medium">GST %<input className="input mt-1 w-24" type="number" step="0.01" min="0" max="100" name="tax_rate" defaultValue="18" /></label>
          <button className="btn">Add product</button>
        </form>)}
    </section>
  );
}
