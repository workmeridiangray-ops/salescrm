"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
function back(slug: string, path: string, error: { message: string } | null, ok: string): never {
  revalidatePath(`/w/${slug}`, "layout");
  redirect(`/w/${slug}/${path}?${error ? `error=${encodeURIComponent(friendlyError(error.message))}` : `ok=${encodeURIComponent(ok)}`}`);
}
export async function createSequence(f: FormData) {
  const { data, error } = await (await createClient()).from("sequences").insert({ tenant_id: s(f, "tenant"), name: s(f, "name") }).select("id").single();
  if (error || !data) back(s(f, "slug"), "sequences", error ?? { message: "x" }, "");
  redirect(`/w/${s(f, "slug")}/sequences/${data!.id}`);
}
export async function addStep(f: FormData) {
  const supabase = await createClient();
  const { count } = await supabase.from("sequence_steps").select("id", { count: "exact", head: true }).eq("sequence_id", s(f, "sequence"));
  const { error } = await supabase.from("sequence_steps").insert({
    tenant_id: s(f, "tenant"), sequence_id: s(f, "sequence"), position: count ?? 0, kind: s(f, "kind") === "task" ? "task" : "email",
    delay_days: Number(s(f, "delay")) || 0, subject: s(f, "subject"), body: String(f.get("body") ?? ""),
  });
  back(s(f, "slug"), `sequences/${s(f, "sequence")}`, error, "Step added");
}
export async function removeLastStep(f: FormData) {
  const supabase = await createClient();
  const { data } = await supabase.from("sequence_steps").select("id").eq("sequence_id", s(f, "sequence")).order("position", { ascending: false }).limit(1).maybeSingle();
  const { error } = data ? await supabase.from("sequence_steps").delete().eq("id", data.id) : { error: null };
  back(s(f, "slug"), `sequences/${s(f, "sequence")}`, error, "Step removed");
}
export async function saveSettings(f: FormData) {
  const { error } = await (await createClient()).from("sequences").update({
    name: s(f, "name"), daily_limit: Number(s(f, "daily_limit")), window_start: s(f, "window_start"), window_end: s(f, "window_end"),
  }).eq("id", s(f, "sequence")).select("id").single();
  back(s(f, "slug"), `sequences/${s(f, "sequence")}`, error, "Saved");
}
export async function setStatus(f: FormData) {
  const { error } = await (await createClient()).rpc("set_sequence_status", { p_sequence: s(f, "sequence"), p_status: s(f, "status") });
  back(s(f, "slug"), `sequences/${s(f, "sequence")}`, error, s(f, "status") === "active" ? "Sequence is live" : "Paused");
}
export async function enrol(f: FormData) {
  const ids = f.getAll("contact").map(String);
  const { data, error } = await (await createClient()).rpc("enrol_contacts", { p_sequence: s(f, "sequence"), p_contacts: ids });
  back(s(f, "slug"), `sequences/${s(f, "sequence")}`, error, `${data ?? 0} contact(s) enrolled`);
}
export async function stopOne(f: FormData) {
  const { error } = await (await createClient()).rpc("stop_enrolment", { p_enrolment: s(f, "id") });
  back(s(f, "slug"), `sequences/${s(f, "sequence")}`, error, "Stopped");
}
export async function markReplied(f: FormData) {
  const { data, error } = await (await createClient()).rpc("mark_replied", { p_contact: s(f, "contact") });
  back(s(f, "slug"), s(f, "back") || "sequences", error, `Marked as replied; ${data ?? 0} sequence(s) stopped`);
}
export async function addSuppression(f: FormData) {
  const { error } = await (await createClient()).rpc("add_suppression", { p_tenant: s(f, "tenant"), p_email: s(f, "email"), p_reason: s(f, "reason") });
  back(s(f, "slug"), "sequences", error, "Added to the suppression list");
}
