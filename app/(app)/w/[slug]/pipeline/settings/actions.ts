"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
function back(f: FormData, error: { message: string } | null, ok: string): never {
  revalidatePath(`/w/${s(f, "slug")}`, "layout");
  redirect(`/w/${s(f, "slug")}/pipeline/settings?${error ? `error=${encodeURIComponent(friendlyError(error.message))}` : `ok=${encodeURIComponent(ok)}`}${s(f, "pipeline") ? `&pipeline=${s(f, "pipeline")}` : ""}`);
}
export async function createPipeline(f: FormData) {
  const { error } = await (await createClient()).rpc("create_pipeline", { p_tenant: s(f, "tenant"), p_name: s(f, "name"), p_template: s(f, "template") });
  back(f, error, "Pipeline created");
}
export async function addStage(f: FormData) {
  const { error } = await (await createClient()).rpc("add_stage", { p_tenant: s(f, "tenant"), p_pipeline: s(f, "pipeline"), p_name: s(f, "name"), p_probability: Number(s(f, "probability")) });
  back(f, error, "Stage added");
}
export async function updateStage(f: FormData) {
  const { error } = await (await createClient()).rpc("update_stage", { p_tenant: s(f, "tenant"), p_stage: s(f, "stage"), p_name: s(f, "name"), p_probability: Number(s(f, "probability")) });
  back(f, error, "Stage saved");
}
export async function moveStage(f: FormData) {
  const { error } = await (await createClient()).rpc("move_stage", { p_tenant: s(f, "tenant"), p_stage: s(f, "stage"), p_direction: Number(s(f, "dir")) });
  back(f, error, "Moved");
}
export async function deleteStage(f: FormData) {
  const { error } = await (await createClient()).rpc("delete_stage", { p_tenant: s(f, "tenant"), p_stage: s(f, "stage") });
  back(f, error, "Stage deleted");
}
