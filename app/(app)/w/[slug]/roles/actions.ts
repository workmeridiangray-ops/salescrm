"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";

const s = (f: FormData, k: string) => String(f.get(k) ?? "");

export async function saveRole(form: FormData) {
  const slug = s(form, "slug");
  const supabase = await createClient();
  const { error } = await supabase.rpc("upsert_role", {
    p_tenant: s(form, "tenant"),
    p_role: s(form, "id") || null,
    p_key: s(form, "key"),
    p_name: s(form, "name"),
    p_perms: form.getAll("perm").map(String),
  });
  redirect(`/w/${slug}/roles${error ? `?error=${encodeURIComponent(friendlyError(error.message))}` : ""}`);
}

export async function deleteRole(form: FormData) {
  const slug = s(form, "slug");
  const supabase = await createClient();
  const { error } = await supabase.rpc("delete_role", { p_tenant: s(form, "tenant"), p_role: s(form, "id") });
  redirect(`/w/${slug}/roles${error ? `?error=${encodeURIComponent(friendlyError(error.message))}` : ""}`);
}
