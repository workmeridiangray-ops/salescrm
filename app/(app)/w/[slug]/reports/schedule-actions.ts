"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
function back(slug: string, error: { message: string } | null, ok: string): never {
  revalidatePath(`/w/${slug}/reports`);
  redirect(`/w/${slug}/reports?${error ? `error=${encodeURIComponent(friendlyError(error.message))}` : `ok=${encodeURIComponent(ok)}`}`);
}
export async function createSchedule(f: FormData) {
  const to = f.getAll("to").map(String).filter(Boolean);
  const { error } = await (await createClient()).rpc("create_report_schedule", { p_tenant: s(f, "tenant"), p_report: s(f, "report"), p_range_days: Number(s(f, "range")), p_frequency: s(f, "frequency"), p_recipients: to });
  back(s(f, "slug"), error, "Schedule created");
}
export async function deleteSchedule(f: FormData) {
  const { error } = await (await createClient()).rpc("delete_report_schedule", { p_tenant: s(f, "tenant"), p_schedule: s(f, "id") });
  back(s(f, "slug"), error, "Schedule removed");
}
