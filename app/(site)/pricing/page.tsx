import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { inr } from "@/lib/util";

export const metadata: Metadata = { title: "Pricing" };
export const dynamic = "force-dynamic";

export default async function Pricing() {
  const supabase = await createClient();
  const { data: plans } = await supabase.from("plans").select("key, name, monthly_inr, yearly_inr, max_users").order("sort");
  return (
    <div className="space-y-6">
      <div><h1 className="text-3xl font-semibold">Pricing</h1>
        <p className="mt-1 text-muted">Every plan starts with a 14-day free trial. Prices are in INR and exclude GST.</p></div>
      <div className="grid gap-4 md:grid-cols-3">
        {(plans ?? []).map((p) => (
          <div key={p.key} className="card flex flex-col">
            <h2 className="text-lg font-semibold">{p.name}</h2>
            <p className="mt-2 text-3xl font-semibold">{inr(p.monthly_inr)}<span className="text-base font-normal text-muted"> / month</span></p>
            <p className="text-sm text-muted">or {inr(p.yearly_inr)} billed yearly</p>
            <ul className="mt-4 flex-1 list-disc space-y-1 pl-5 text-sm"><li>Up to {p.max_users} users</li><li>Accounts, contacts, leads, pipeline</li><li>Roles, permissions and audit trail</li></ul>
            <Link href="/login?mode=signup" className="btn mt-4">Start free trial</Link>
          </div>
        ))}
        {(plans ?? []).length === 0 && <p className="card md:col-span-3">Plans are being set up. <Link className="text-accent underline" href="/demo">Contact us</Link>.</p>}
      </div>
    </div>
  );
}
