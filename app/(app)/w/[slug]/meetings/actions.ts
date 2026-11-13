"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
function back(slug: string, error: { message: string } | null, ok: string): never {
  revalidatePath(`/w/${slug}/meetings`);
  redirect(`/w/${slug}/meetings?${error ? `error=${encodeURIComponent(friendlyError(error.message))}` : `ok=${encodeURIComponent(ok)}`}`);
}
export async function createMeeting(f: FormData) {
  const start = new Date(s(f, "start")), mins = Number(s(f, "minutes")) || 30;
  if (Number.isNaN(start.getTime())) back(s(f, "slug"), { message: "invalid_request" }, "");
  const { error } = await (await createClient()).from("meetings").insert({
    tenant_id: s(f, "tenant"), title: s(f, "title"), starts_at: start.toISOString(), ends_at: new Date(start.getTime() + mins * 60000).toISOString(),
    buffer_min: Number(s(f, "buffer")) || 0, contact_id: s(f, "contact") || null, notes: s(f, "notes") || null,
  });
  back(s(f, "slug"), error, "Meeting scheduled");
}
export async function setOutcome(f: FormData) {
  const status = ["completed", "no_show", "cancelled"].includes(s(f, "status")) ? s(f, "status") : "completed";
  const { error } = await (await createClient()).from("meetings").update({ status, outcome: s(f, "outcome") || null }).eq("id", s(f, "id")).select("id").single();
  back(s(f, "slug"), error, status === "cancelled" ? "Meeting cancelled" : "Outcome recorded");
}
export async function saveAvailability(f: FormData) {
  const rules: { weekday: number; start: string; end: string }[] = [];
  for (let d = 0; d < 7; d++) if (f.get(`on_${d}`) === "on") rules.push({ weekday: d, start: s(f, `start_${d}`) || "09:00", end: s(f, `end_${d}`) || "17:00" });
  const { error } = await (await createClient()).rpc("set_availability", { p_tenant: s(f, "tenant"), p_rules: rules });
  back(s(f, "slug"), error, "Availability saved");
}
export async function createLink(f: FormData) {
  const { error } = await (await createClient()).from("booking_links").insert({
    tenant_id: s(f, "tenant"), slug: s(f, "slug_value").toLowerCase(), title: s(f, "title"), duration_min: Number(s(f, "duration")),
    buffer_min: Number(s(f, "buffer")) || 0, notice_hours: Number(s(f, "notice")) || 0, window_days: Number(s(f, "window")) || 14, tz: s(f, "tz") || "Asia/Kolkata",
  });
  back(s(f, "slug"), error, "Booking page created");
}
export async function toggleLink(f: FormData) {
  const { error } = await (await createClient()).from("booking_links").update({ active: s(f, "active") === "true" }).eq("id", s(f, "id")).select("id").single();
  back(s(f, "slug"), error, "Updated");
}
