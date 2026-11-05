import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getWorkspace } from "@/lib/workspace";
import { Empty, Hidden, Notice, Pager } from "@/components/ui";
import { PAGE_SIZE, likeTerm, pageOf } from "@/lib/util";
import { createAccount } from "../actions";

export const metadata: Metadata = { title: "Accounts" };

export default async function Accounts({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant } = await getWorkspace(slug);
  const page = pageOf(sp.page);
  const q = (sp.q ?? "").trim();
  const supabase = await createClient();
  let query = supabase.from("accounts").select("id, name, domain, industry, created_at").eq("tenant_id", tenant.id).is("archived_at", null)
    .order("name").range((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  if (q) query = query.or(`name.ilike.${likeTerm(q)},domain.ilike.${likeTerm(q)}`);
  const { data } = await query;
  const rows = (data ?? []).slice(0, PAGE_SIZE);
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Accounts</h1>
      <Notice error={sp.error} ok={sp.ok} />
      <form className="flex gap-2" role="search"><input className="input max-w-sm" name="q" defaultValue={q} placeholder="Search accounts" aria-label="Search accounts" /><button className="btn-quiet">Search</button></form>
      {rows.length === 0 ? <Empty>{q ? "No accounts match." : "No accounts yet. Create the first one below."}</Empty> : (
        <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm">
          <thead className="border-b border-line text-muted"><tr><th className="p-3">Name</th><th className="p-3">Domain</th><th className="p-3">Industry</th></tr></thead>
          <tbody>{rows.map((a) => (
            <tr key={a.id} className="border-b border-line last:border-0">
              <td className="p-3"><a className="font-medium text-accent underline" href={`/w/${slug}/accounts/${a.id}`}>{a.name}</a></td>
              <td className="p-3">{a.domain ?? "—"}</td><td className="p-3">{a.industry ?? "—"}</td>
            </tr>))}</tbody></table></div>
      )}
      <Pager base={`/w/${slug}/accounts${q ? `?q=${encodeURIComponent(q)}` : ""}`} page={page} more={(data ?? []).length > PAGE_SIZE} />
      <form action={createAccount} className="card flex flex-wrap items-end gap-3">
        <Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} />
        <label className="text-sm font-medium">Name<input className="input mt-1" name="name" required /></label>
        <label className="text-sm font-medium">Domain<input className="input mt-1" name="domain" placeholder="example.com" /></label>
        <label className="text-sm font-medium">Industry<input className="input mt-1" name="industry" /></label>
        <button className="btn">Create account</button>
      </form>
    </section>
  );
}
