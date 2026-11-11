"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";
import { isPeriod } from "@/lib/rules/quote";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
function back(f: FormData, error: { message: string } | null, ok: string): never {
  const p = isPeriod(s(f, "period")) ? s(f, "period") : "";
  revalidatePath(`/w/${s(f, "slug")}/forecast`);
  redirect(`/w/${s(f, "slug")}/forecast?period=${p}&${error ? `error=${encodeURIComponent(friendlyError(error.message))}` : `ok=${encodeURIComponent(ok)}`}`);
}

export async function setTarget(f: FormData) {
  const { error } = await (await createClient()).rpc("set_forecast_target", { p_tenant: s(f, "tenant"), p_period: s(f, "period"), p_owner: s(f, "owner") || null, p_amount: Number(s(f, "amount")) });
  back(f, error, "Target saved");
}
export async function setOverride(f: FormData) {
  const { error } = await (await createClient()).rpc("set_forecast_override", {
    p_tenant: s(f, "tenant"), p_period: s(f, "period"), p_owner: s(f, "owner"), p_category: s(f, "category"), p_amount: Number(s(f, "amount")), p_reason: s(f, "reason"),
  });
  back(f, error, "Adjustment recorded");
}
export async function takeSnapshot(f: FormData) {
  const { error } = await (await createClient()).rpc("take_forecast_snapshot", { p_tenant: s(f, "tenant"), p_period: s(f, "period") });
  back(f, error, "Snapshot saved");
}
