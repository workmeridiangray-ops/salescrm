"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";
import { EVENTS, SCOPES } from "@/lib/api-keys";
import { isSafeWebhookUrl } from "@/lib/webhooks";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
function back(slug: string, q: Record<string, string>): never {
  revalidatePath(`/w/${slug}/integrations`);
  redirect(`/w/${slug}/integrations?${new URLSearchParams(q)}`);
}
const err = (slug: string, e: { message: string }): never => back(slug, { error: friendlyError(e.message) });

export async function createKey(f: FormData) {
  const slug = s(f, "slug");
  const scopes = f.getAll("scope").map(String).filter((x) => (SCOPES as readonly string[]).includes(x));
  if (scopes.length === 0) back(slug, { error: "Choose at least one permission for the key." });
  const { data, error } = await (await createClient()).rpc("create_api_key", { p_tenant: s(f, "tenant"), p_name: s(f, "name"), p_scopes: scopes });
  if (error) err(slug, error);
  back(slug, { newkey: String(data) });   // shown once, then gone
}
export async function revokeKey(f: FormData) {
  const { error } = await (await createClient()).rpc("revoke_api_key", { p_tenant: s(f, "tenant"), p_key: s(f, "id") });
  if (error) err(s(f, "slug"), error);
  back(s(f, "slug"), { ok: "Key revoked" });
}
export async function createHook(f: FormData) {
  const slug = s(f, "slug"), url = s(f, "url");
  if (!isSafeWebhookUrl(url)) back(slug, { error: "Use a public https:// address (no localhost, private addresses, credentials or custom ports)." });
  const events = f.getAll("event").map(String).filter((x) => (EVENTS as readonly string[]).includes(x));
  if (events.length === 0) back(slug, { error: "Choose at least one event." });
  const { data, error } = await (await createClient()).rpc("create_webhook", { p_tenant: s(f, "tenant"), p_url: url, p_events: events });
  if (error) err(slug, error);
  back(slug, { newsecret: String((data as { secret: string }).secret) });
}
export async function toggleHook(f: FormData) {
  const { error } = await (await createClient()).rpc("set_webhook_active", { p_tenant: s(f, "tenant"), p_endpoint: s(f, "id"), p_active: s(f, "active") === "true" });
  if (error) err(s(f, "slug"), error);
  back(s(f, "slug"), { ok: "Webhook updated" });
}
export async function retryDelivery(f: FormData) {
  const { error } = await (await createClient()).rpc("retry_delivery", { p_tenant: s(f, "tenant"), p_delivery: Number(s(f, "id")) });
  if (error) err(s(f, "slug"), error);
  back(s(f, "slug"), { ok: "Queued for retry" });
}
