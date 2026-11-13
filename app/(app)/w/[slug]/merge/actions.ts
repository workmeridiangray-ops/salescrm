"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";

export async function confirmMerge(f: FormData) {
  const s = (k: string) => String(f.get(k) ?? "");
  const entity = s("entity");
  const { error } = await (await createClient()).rpc("merge_records", { p_entity: entity, p_keep: s("keep"), p_remove: s("remove") });
  revalidatePath(`/w/${s("slug")}`, "layout");
  redirect(`/w/${s("slug")}/merge?entity=${entity}&${error ? `error=${encodeURIComponent(friendlyError(error.message))}` : "ok=Records%20merged"}`);
}
