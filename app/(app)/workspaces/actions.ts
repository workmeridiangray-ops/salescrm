"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { friendlyError, slugify } from "@/lib/rules/permissions";

export async function createWorkspace(form: FormData) {
  const name = String(form.get("name") ?? "").trim();
  const slug = String(form.get("slug") ?? "").trim() || slugify(name);
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_workspace", { p_name: name, p_slug: slug });
  if (error) redirect(`/workspaces?error=${encodeURIComponent(friendlyError(error.message))}`);
  redirect(`/w/${slug.toLowerCase()}`);
}
