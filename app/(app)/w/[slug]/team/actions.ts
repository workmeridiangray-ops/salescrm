"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
function back(f: FormData, error: { message: string } | null, ok: string): never {
  revalidatePath(`/w/${s(f, "slug")}/team`);
  redirect(`/w/${s(f, "slug")}/team?${error ? `error=${encodeURIComponent(friendlyError(error.message))}` : `ok=${encodeURIComponent(ok)}`}`);
}

export async function createTeam(f: FormData) {
  const { error } = await (await createClient()).from("teams").insert({ tenant_id: s(f, "tenant"), name: s(f, "name") });
  back(f, error, "Team created");
}
export async function addToTeam(f: FormData) {
  const { error } = await (await createClient()).from("team_members").upsert(
    { tenant_id: s(f, "tenant"), team_id: s(f, "team"), user_id: s(f, "user"), is_lead: f.get("lead") === "on" }, { onConflict: "team_id,user_id" });
  back(f, error, "Team updated");
}
export async function removeFromTeam(f: FormData) {
  const { error } = await (await createClient()).from("team_members").delete().eq("team_id", s(f, "team")).eq("user_id", s(f, "user"));
  back(f, error, "Removed from team");
}
export async function reassign(f: FormData) {
  const { data, error } = await (await createClient()).rpc("reassign_records", { p_tenant: s(f, "tenant"), p_from: s(f, "from"), p_to: s(f, "to") });
  const d = (data ?? {}) as Record<string, number>;
  back(f, error, `Moved ${d.accounts ?? 0} accounts, ${d.contacts ?? 0} contacts, ${d.leads ?? 0} leads, ${d.opportunities ?? 0} opportunities, ${d.open_tasks ?? 0} tasks, ${d.open_quotes ?? 0} quotes`);
}

export async function addRule(f: FormData) {
  const { error } = await (await createClient()).rpc("add_territory_rule", { p_tenant: s(f, "tenant"), p_domain: s(f, "domain"), p_owner: s(f, "owner") });
  back(f, error, "Rule added");
}
export async function deleteRule(f: FormData) {
  const { error } = await (await createClient()).rpc("delete_territory_rule", { p_tenant: s(f, "tenant"), p_rule: s(f, "id") });
  back(f, error, "Rule removed");
}
export async function moveRule(f: FormData) {
  const { error } = await (await createClient()).rpc("move_territory_rule", { p_tenant: s(f, "tenant"), p_rule: s(f, "id"), p_direction: Number(s(f, "dir")) });
  back(f, error, "Order changed");
}
export async function applyRules(f: FormData) {
  const { data, error } = await (await createClient()).rpc("apply_territory_rules", { p_tenant: s(f, "tenant") });
  back(f, error, `${data ?? 0} unassigned lead(s) routed`);
}
