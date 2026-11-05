import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getWorkspace } from "@/lib/workspace";
import { Badge, Empty, Hidden, Notice, Pager } from "@/components/ui";
import { PAGE_SIZE, likeTerm, one, pageOf } from "@/lib/util";
import { createContact } from "../actions";

export const metadata: Metadata = { title: "Contacts" };

export default async function Contacts({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant } = await getWorkspace(slug);
  const page = pageOf(sp.page);
  const q = (sp.q ?? "").trim();
  const supabase = await createClient();
  let query = supabase.from("contacts").select("id, full_name, email, phone, job_title, opted_out, accounts(id, name)").eq("tenant_id", tenant.id).is("archived_at", null)
    .order("full_name").range((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  if (q) query = query.or(`full_name.ilike.${likeTerm(q)},email.ilike.${likeTerm(q)}`);
  const [{ data }, { data: accounts }] = await Promise.all([query, supabase.from("accounts").select("id, name").eq("tenant_id", tenant.id).is("archived_at", null).order("name").limit(500)]);
  const rows = (data ?? []).slice(0, PAGE_SIZE);
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Contacts</h1>
      <Notice error={sp.error} ok={sp.ok} />
      <form className="flex gap-2" role="search"><input className="input max-w-sm" name="q" defaultValue={q} placeholder="Search name or email" aria-label="Search contacts" /><button className="btn-quiet">Search</button></form>
      {rows.length === 0 ? <Empty>{q ? "No contacts match." : "No contacts yet."}</Empty> : (
        <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm">
          <thead className="border-b border-line text-muted"><tr><th className="p-3">Name</th><th className="p-3">Email</th><th className="p-3">Account</th><th className="p-3">Status</th></tr></thead>
          <tbody>{rows.map((c) => { const a = one(c.accounts as { id: string; name: string } | { id: string; name: string }[] | null); return (
            <tr key={c.id} className="border-b border-line last:border-0"><td className="p-3 font-medium">{c.full_name}<span className="block text-muted">{c.job_title}</span></td>
              <td className="p-3">{c.email ?? "—"}</td>
              <td className="p-3">{a ? <a className="text-accent underline" href={`/w/${slug}/accounts/${a.id}`}>{a.name}</a> : "—"}</td>
              <td className="p-3">{c.opted_out ? <Badge tone="red">Opted out</Badge> : <Badge tone="green">Reachable</Badge>}</td></tr>); })}</tbody></table></div>
      )}
      <Pager base={`/w/${slug}/contacts${q ? `?q=${encodeURIComponent(q)}` : ""}`} page={page} more={(data ?? []).length > PAGE_SIZE} />
      <form action={createContact} className="card flex flex-wrap items-end gap-3">
        <Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} />
        <label className="text-sm font-medium">Name<input className="input mt-1" name="full_name" required /></label>
        <label className="text-sm font-medium">Email<input className="input mt-1" type="email" name="email" /></label>
        <label className="text-sm font-medium">Phone<input className="input mt-1" name="phone" /></label>
        <label className="text-sm font-medium">Account<select className="input mt-1" name="account_id"><option value="">None</option>{(accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <button className="btn">Add contact</button>
      </form>
    </section>
  );
}
