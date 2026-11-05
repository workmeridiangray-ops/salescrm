import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { currentUser } from "@/lib/workspace";
import { Badge, Empty, Hidden, Notice } from "@/components/ui";
import { expireSubscriptions, setPlan, setTenantStatus } from "./actions";

export const metadata: Metadata = { title: "Platform admin" };

export default async function Admin({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  await currentUser();
  const supabase = await createClient();
  const { data: tenants, error } = await supabase.rpc("platform_overview");
  if (error) notFound(); // not platform staff: the page doesn't exist for them
  const [{ data: plans }, { data: demos }] = await Promise.all([
    supabase.from("plans").select("key, name").order("sort"),
    supabase.rpc("platform_demo_requests"), // fails for roles without access: treated as empty
  ]);
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-2xl font-semibold">Platform admin</h1>
        <form action={expireSubscriptions}><button className="btn-quiet">Suspend lapsed trials and unpaid workspaces</button></form></div>
      <Notice error={sp.error} ok={sp.ok} />
      <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm">
        <thead className="border-b border-line text-muted"><tr><th className="p-3">Workspace</th><th className="p-3">Status</th><th className="p-3">Plan</th><th className="p-3">Users</th><th className="p-3">Actions (reason required)</th></tr></thead>
        <tbody>{(tenants ?? []).map((t: any) => (
          <tr key={t.tenant_id} className="border-b border-line align-top last:border-0">
            <td className="p-3"><p className="font-medium">{t.name}</p><p className="text-muted">{t.slug}</p></td>
            <td className="p-3"><Badge tone={t.tenant_status === "suspended" ? "red" : "green"}>{t.tenant_status}</Badge> <span className="text-muted">{t.sub_status}</span></td>
            <td className="p-3">{t.plan_key}</td><td className="p-3">{t.users}</td>
            <td className="p-3 space-y-2">
              <form action={setTenantStatus} className="flex gap-2"><Hidden name="tenant" value={t.tenant_id} />
                <input className="input w-44" name="reason" placeholder="Reason" required aria-label="Reason" />
                <button className="btn-quiet" name="status" value={t.tenant_status === "suspended" ? "active" : "suspended"}>{t.tenant_status === "suspended" ? "Reinstate" : "Suspend"}</button></form>
              <form action={setPlan} className="flex gap-2"><Hidden name="tenant" value={t.tenant_id} />
                <select name="plan" className="input w-32" defaultValue={t.plan_key} aria-label="Plan">{(plans ?? []).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</select>
                <input className="input w-44" name="reason" placeholder="Reason" required aria-label="Reason" /><button className="btn-quiet">Set plan</button></form>
            </td></tr>))}</tbody></table></div>
      <div><h2 className="text-lg font-semibold">Demo requests</h2>
        {(demos ?? []).length === 0 ? <Empty>None.</Empty> : <ul className="mt-2 space-y-2">{(demos ?? []).map((d: any) => (
          <li key={d.id} className="card text-sm"><strong>{d.name}</strong> · {d.email}{d.company && ` · ${d.company}`}<p className="text-muted">{d.message}</p></li>))}</ul>}</div>
    </main>
  );
}
