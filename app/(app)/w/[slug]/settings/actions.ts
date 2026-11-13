"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
function back(slug: string, error: { message: string } | null, ok: string): never {
  revalidatePath(`/w/${slug}`, "layout");
  redirect(`/w/${slug}/settings?${error ? `error=${encodeURIComponent(friendlyError(error.message))}` : `ok=${encodeURIComponent(ok)}`}`);
}
export async function rename(f: FormData) {
  back(s(f, "slug"), (await (await createClient()).rpc("update_workspace", { p_tenant: s(f, "tenant"), p_name: s(f, "name") })).error, "Workspace renamed");
}
export async function grantSupport(f: FormData) {
  back(s(f, "slug"), (await (await createClient()).rpc("grant_support_access", { p_tenant: s(f, "tenant"), p_hours: Number(s(f, "hours")), p_note: s(f, "note") })).error, "Support access granted");
}
export async function revokeSupport(f: FormData) {
  back(s(f, "slug"), (await (await createClient()).rpc("revoke_support_access", { p_tenant: s(f, "tenant"), p_grant: s(f, "id") })).error, "Support access revoked");
}
export async function requestClosure(f: FormData) {
  back(s(f, "slug"), (await (await createClient()).rpc("request_closure", { p_tenant: s(f, "tenant"), p_confirm_slug: s(f, "confirm") })).error, "Closure scheduled");
}
export async function cancelClosure(f: FormData) {
  back(s(f, "slug"), (await (await createClient()).rpc("cancel_closure", { p_tenant: s(f, "tenant") })).error, "Closure cancelled");
}
