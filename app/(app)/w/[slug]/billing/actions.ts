"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/rules/permissions";

/** Creates a Razorpay subscription for the chosen plan and sends the owner to Razorpay's hosted checkout. */
export async function startCheckout(form: FormData) {
  const slug = String(form.get("slug") ?? "");
  const planKey = String(form.get("plan") ?? "");
  const interval = form.get("interval") === "yearly" ? "yearly" : "monthly";
  const back = (msg: string) => redirect(`/w/${slug}/billing?error=${encodeURIComponent(msg)}`);

  const supabase = await createClient();
  const { data: tenant } = await supabase.from("tenants").select("id").eq("slug", slug).maybeSingle();
  if (!tenant) return back("Workspace not found.");
  const { data: { user } } = await supabase.auth.getUser();
  const { data: me } = await supabase.from("memberships").select("roles(permissions)").eq("tenant_id", tenant.id).eq("user_id", user?.id ?? "").maybeSingle();
  const perms = ((Array.isArray(me?.roles) ? me?.roles[0] : me?.roles)?.permissions ?? []) as string[];
  if (!can(perms, "billing.manage")) return back("You don't have permission to manage billing.");

  const { data: plan } = await supabase.from("plans").select("key, razorpay_plan_monthly, razorpay_plan_yearly").eq("key", planKey).maybeSingle();
  const rzpPlan = interval === "yearly" ? plan?.razorpay_plan_yearly : plan?.razorpay_plan_monthly;
  const keyId = process.env.RAZORPAY_KEY_ID, keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!plan || !rzpPlan || !keyId || !keySecret) return back("Online payment isn't switched on yet. Contact support to change your plan.");

  const res = await fetch("https://api.razorpay.com/v1/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}` },
    body: JSON.stringify({
      plan_id: rzpPlan, total_count: interval === "yearly" ? 10 : 120, customer_notify: 1,
      notes: { tenant_id: tenant.id, plan_key: plan.key, interval },
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { short_url?: string };
  if (!res.ok || !json.short_url) return back("We couldn't start checkout. Please try again.");
  redirect(json.short_url);
}
