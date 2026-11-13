"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
function back(path: string, error: { message: string } | null, ok: string): never {
  revalidatePath(path);
  redirect(`${path}?${error ? `error=${encodeURIComponent(friendlyError(error.message))}` : `ok=${encodeURIComponent(ok)}`}`);
}

export async function createField(f: FormData) {
  const opts = s(f, "options").split(",").map((x) => x.trim()).filter(Boolean);
  const { error } = await (await createClient()).rpc("create_custom_field", {
    p_tenant: s(f, "tenant"), p_entity: s(f, "entity"), p_key: s(f, "key"), p_label: s(f, "label"), p_type: s(f, "type"), p_options: opts, p_required: f.get("required") === "on",
  });
  back(`/w/${s(f, "slug")}/fields`, error, "Field created");
}
export async function toggleField(f: FormData) {
  const { error } = await (await createClient()).rpc("set_custom_field_active", { p_tenant: s(f, "tenant"), p_field: s(f, "id"), p_active: s(f, "active") === "true" });
  back(`/w/${s(f, "slug")}/fields`, error, "Field updated");
}

/** Saves values for the workspace's active fields on one record, keeping values of hidden fields untouched. */
export async function saveCustomValues(f: FormData) {
  const slug = s(f, "slug"), entity = s(f, "entity"), id = s(f, "id"), back_to = s(f, "back");
  if (!["accounts", "contacts", "leads", "opportunities"].includes(entity)) redirect(`/w/${slug}`);
  const supabase = await createClient();
  const { data: defs } = await supabase.from("custom_field_defs").select("key, type").eq("tenant_id", s(f, "tenant")).eq("entity", entity).eq("active", true);
  const { data: row } = await supabase.from(entity).select("custom").eq("id", id).maybeSingle();
  const next: Record<string, unknown> = { ...((row?.custom as Record<string, unknown>) ?? {}) };
  for (const d of defs ?? []) {
    const raw = f.get(`cf_${d.key}`);
    if (d.type === "checkbox") next[d.key] = raw === "on";
    else if (raw === null || String(raw).trim() === "") delete next[d.key];
    else next[d.key] = d.type === "number" ? Number(raw) : String(raw).trim();
  }
  const { error } = await supabase.from(entity).update({ custom: next }).eq("id", id).select("id").single();
  back(back_to || `/w/${slug}/fields`, error, "Saved");
}
