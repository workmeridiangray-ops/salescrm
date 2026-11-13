"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const opt = (f: FormData, k: string) => s(f, k) || null;

async function finish(slug: string, area: string, error: { message: string } | null, ok?: string) {
  if (error) redirect(`/w/${slug}/${area}?error=${encodeURIComponent(friendlyError(error.message))}`);
  revalidatePath(`/w/${slug}`, "layout");
  redirect(`/w/${slug}/${area}${ok ? `?ok=${encodeURIComponent(ok)}` : ""}`);
}

export async function createAccount(f: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from("accounts").insert({ tenant_id: s(f, "tenant"), name: s(f, "name"), domain: opt(f, "domain")?.toLowerCase() ?? null, industry: opt(f, "industry") });
  await finish(s(f, "slug"), "accounts", error, "Account created");
}

export async function createContact(f: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from("contacts").insert({
    tenant_id: s(f, "tenant"), full_name: s(f, "full_name"), email: opt(f, "email")?.toLowerCase() ?? null,
    phone: opt(f, "phone"), job_title: opt(f, "job_title"), account_id: opt(f, "account_id"),
  });
  await finish(s(f, "slug"), s(f, "back") || "contacts", error, "Contact created");
}

export async function archiveRecord(f: FormData) {
  const table = s(f, "table");
  if (!["accounts", "contacts", "opportunities"].includes(table)) redirect(`/w/${s(f, "slug")}`);
  const supabase = await createClient();
  const { error } = await supabase.from(table).update({ archived_at: new Date().toISOString() }).eq("id", s(f, "id"));
  await finish(s(f, "slug"), table === "opportunities" ? "pipeline" : table, error, "Archived");
}

export async function createLead(f: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from("leads").insert({
    tenant_id: s(f, "tenant"), name: s(f, "name"), email: opt(f, "email")?.toLowerCase() ?? null,
    company: opt(f, "company"), phone: opt(f, "phone"), message: opt(f, "message"),
    source: s(f, "source") === "referral" ? "referral" : "manual", owner_id: s(f, "owner") || undefined,
  });
  await finish(s(f, "slug"), "leads", error, "Lead added");
}

export async function qualifyLead(f: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from("leads").update({ status: "qualified" }).eq("id", s(f, "id")).select("id").single();
  await finish(s(f, "slug"), "leads", error, "Lead qualified");
}

export async function disqualifyLead(f: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from("leads")
    .update({ status: "disqualified", disqualify_reason: s(f, "reason"), can_return: f.get("can_return") === "on" })
    .eq("id", s(f, "id")).select("id").single();
  await finish(s(f, "slug"), "leads", error, "Lead disqualified");
}

export async function convertLead(f: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.rpc("convert_lead", { p_lead: s(f, "id"), p_amount: Number(s(f, "amount")) || 0 });
  await finish(s(f, "slug"), error ? "leads" : "pipeline", error, "Lead converted to an opportunity");
}

export async function createOpportunity(f: FormData) {
  const supabase = await createClient();
  const tenant = s(f, "tenant");
  let sq = supabase.from("stages").select("id, pipeline_id").eq("tenant_id", tenant).eq("kind", "open").order("position").limit(1);
  if (s(f, "pipeline")) sq = sq.eq("pipeline_id", s(f, "pipeline"));
  const { data: st } = await sq.maybeSingle();
  if (!st) return finish(s(f, "slug"), "pipeline", { message: "no stage" });
  const { error } = await supabase.from("opportunities").insert({
    tenant_id: tenant, name: s(f, "name"), amount: Number(s(f, "amount")) || 0, account_id: opt(f, "account_id"),
    pipeline_id: st.pipeline_id, stage_id: st.id, expected_close: opt(f, "expected_close"),
    next_action: opt(f, "next_action"), next_action_due: opt(f, "next_action_due"),
  });
  await finish(s(f, "slug"), "pipeline", error, "Opportunity created");
}

export async function moveOpportunity(f: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from("opportunities")
    .update({ stage_id: s(f, "stage"), loss_reason: opt(f, "loss_reason") })
    .eq("id", s(f, "id")).select("id").single();
  await finish(s(f, "slug"), "pipeline", error);
}

export async function setNextAction(f: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from("opportunities")
    .update({ next_action: opt(f, "next_action"), next_action_due: opt(f, "next_action_due") }).eq("id", s(f, "id")).select("id").single();
  await finish(s(f, "slug"), s(f, "back") || "today", error, "Next action saved");
}

export async function addActivity(f: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from("activities").insert({
    tenant_id: s(f, "tenant"), kind: s(f, "kind") || "task", subject: s(f, "subject"), body: opt(f, "body"), outcome: opt(f, "outcome"),
    due_at: opt(f, "due_at"), account_id: opt(f, "account_id"), contact_id: opt(f, "contact_id"), opportunity_id: opt(f, "opportunity_id"),
    done_at: s(f, "kind") === "task" ? null : new Date().toISOString(),
  });
  await finish(s(f, "slug"), s(f, "back") || "today", error, "Saved");
}

export async function completeActivity(f: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from("activities").update({ done_at: new Date().toISOString(), outcome: opt(f, "outcome") }).eq("id", s(f, "id")).select("id").single();
  await finish(s(f, "slug"), s(f, "back") || "today", error);
}
