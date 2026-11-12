"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
export async function saveView(f: FormData) {
  const slug = s(f, "slug"), report = s(f, "report");
  const { error } = await (await createClient()).from("saved_views").insert({
    tenant_id: s(f, "tenant"), report, name: s(f, "name"), params: { from: s(f, "from"), to: s(f, "to") }, shared: f.get("shared") === "on",
  });
  const q = new URLSearchParams({ report, from: s(f, "from"), to: s(f, "to") });
  if (error) q.set("error", /duplicate/.test(error.message) ? "You already have a view with that name." : friendlyError(error.message));
  redirect(`/w/${slug}/reports?${q}`);
}
export async function deleteView(f: FormData) {
  await (await createClient()).from("saved_views").delete().eq("id", s(f, "id"));
  redirect(`/w/${s(f, "slug")}/reports?report=${s(f, "report")}`);
}
