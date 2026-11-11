"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
function back(f: FormData, error: { message: string } | null, ok: string, to?: string): never {
  const path = to ?? `handovers/${s(f, "id")}`;
  revalidatePath(`/w/${s(f, "slug")}`, "layout");
  redirect(`/w/${s(f, "slug")}/${path}?${error ? `error=${encodeURIComponent(friendlyError(error.message))}` : `ok=${encodeURIComponent(ok)}`}`);
}

export async function saveHandover(f: FormData) {
  const { error } = await (await createClient()).from("handovers").update({
    scope: s(f, "scope") || null, commercial_terms: s(f, "commercial_terms") || null, commitments: s(f, "commitments") || null,
    renewal_date: s(f, "renewal_date") || null, escalated_reason: s(f, "escalated_reason") || null,
  }).eq("id", s(f, "id")).select("id").single();
  back(f, error, "Saved");
}
export async function toggleItem(f: FormData) {
  const { error } = await (await createClient()).rpc("set_handover_item", { p_item: s(f, "item"), p_done: s(f, "done") === "true" });
  back(f, error, "Updated");
}
export async function completeHandover(f: FormData) {
  const { error } = await (await createClient()).rpc("complete_handover", { p_handover: s(f, "id") });
  back(f, error, "Handover complete");
}
export async function startRenewal(f: FormData) {
  const supabase = await createClient();
  const kind = s(f, "kind") === "expansion" ? "expansion" : "renewal";
  const { error } = await supabase.rpc("create_renewal", { p_opportunity: s(f, "opportunity"), p_date: s(f, "date"), p_kind: kind });
  back(f, error, `${kind === "renewal" ? "Renewal" : "Expansion"} opportunity created`, error ? undefined : "renewals");
}
