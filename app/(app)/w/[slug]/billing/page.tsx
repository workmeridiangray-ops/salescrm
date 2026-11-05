import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/rules/permissions";
import { getWorkspace } from "@/lib/workspace";
import { Badge, Hidden, Notice } from "@/components/ui";
import { inr } from "@/lib/util";
import { startCheckout } from "./actions";

export const metadata: Metadata = { title: "Billing" };

export default async function Billing({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant, perms } = await getWorkspace(slug);
  const supabase = await createClient();
  const [{ data: sub }, { data: plans }, { count: seats }] = await Promise.all([
    supabase.from("subscriptions").select("plan_key, status, billing_interval, trial_ends_at, current_period_end, grace_until").eq("tenant_id", tenant.id).maybeSingle(),
    supabase.from("plans").select("key, name, monthly_inr, yearly_inr, max_users").order("sort"),
    supabase.from("memberships").select("user_id", { count: "exact", head: true }).eq("tenant_id", tenant.id),
  ]);
  const current = (plans ?? []).find((p) => p.key === sub?.plan_key);
  const manage = can(perms, "billing.manage");
  const date = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString("en-IN") : "—");
  return (
    <section className="space-y-5">
      <h1 className="text-2xl font-semibold">Billing</h1>
      <Notice error={sp.error} />
      <div className="card space-y-1">
        <p>Plan: <strong>{current?.name ?? "—"}</strong> <Badge tone={sub?.status === "active" ? "green" : sub?.status === "past_due" || sub?.status === "canceled" ? "red" : "blue"}>{sub?.status}</Badge></p>
        <p className="text-sm text-muted">Users: {seats ?? 0} of {current?.max_users ?? "—"}</p>
        {sub?.status === "trialing" && <p className="text-sm text-muted">Trial ends {date(sub.trial_ends_at)}. After that the workspace is suspended unless you subscribe.</p>}
        {sub?.status === "active" && <p className="text-sm text-muted">Renews {date(sub.current_period_end)}.</p>}
        {sub?.status === "past_due" && <p role="alert" className="text-sm text-red-700">Your last payment failed. Update your payment before {date(sub.grace_until)} to keep access.</p>}
      </div>
      {!manage && <p className="text-muted">Only a workspace owner can change the plan.</p>}
      {manage && (
        <div className="grid gap-4 md:grid-cols-3">
          {(plans ?? []).map((p) => (
            <form key={p.key} action={startCheckout} className="card flex flex-col gap-2">
              <Hidden name="slug" value={slug} /><Hidden name="plan" value={p.key} />
              <h2 className="font-semibold">{p.name}</h2>
              <p className="text-sm text-muted">Up to {p.max_users} users</p>
              <label className="text-sm">Billing
                <select name="interval" className="input mt-1"><option value="monthly">{inr(p.monthly_inr)} / month</option><option value="yearly">{inr(p.yearly_inr)} / year</option></select></label>
              <button className="btn mt-auto" disabled={p.key === sub?.plan_key && sub?.status === "active"}>{p.key === sub?.plan_key && sub?.status === "active" ? "Current plan" : "Choose plan"}</button>
            </form>
          ))}
        </div>
      )}
    </section>
  );
}
