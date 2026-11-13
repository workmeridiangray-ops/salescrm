"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
function back(error: { message: string } | null, ok: string): never {
  revalidatePath("/admin");
  redirect(`/admin?${error ? `error=${encodeURIComponent(friendlyError(error.message))}` : `ok=${encodeURIComponent(ok)}`}`);
}

export async function setTenantStatus(f: FormData) {
  const { error } = await (await createClient()).rpc("platform_set_tenant_status", { p_tenant: s(f, "tenant"), p_status: s(f, "status"), p_reason: s(f, "reason") });
  back(error, "Status updated");
}
export async function setPlan(f: FormData) {
  const { error } = await (await createClient()).rpc("platform_set_plan", { p_tenant: s(f, "tenant"), p_plan: s(f, "plan"), p_reason: s(f, "reason") });
  back(error, "Plan updated");
}
export async function expireSubscriptions() {
  const { data, error } = await (await createClient()).rpc("platform_expire_subscriptions");
  back(error, `${data ?? 0} workspace(s) suspended`);
}
export async function purgeClosed() {
  const { data, error } = await (await createClient()).rpc("platform_purge_closed");
  back(error, `${data ?? 0} closed workspace(s) permanently deleted`);
}
