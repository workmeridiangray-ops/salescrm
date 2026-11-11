"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";
import { MAX_BYTES, importError, validateImport, type ImportEntity } from "@/lib/import";

const ENT: ImportEntity[] = ["accounts", "contacts", "leads"];
const s = (f: FormData, k: string) => String(f.get(k) ?? "");

async function csvText(f: FormData): Promise<string> {
  const file = f.get("file");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_BYTES) return "x".repeat(MAX_BYTES + 1);
    return await file.text();
  }
  return s(f, "csv");
}

/** Re-validates everything server-side: the browser's preview is never trusted. */
export async function runImport(f: FormData) {
  const slug = s(f, "slug"), entity = s(f, "entity") as ImportEntity;
  const fail = (m: string): never => redirect(`/w/${slug}/data?error=${encodeURIComponent(m)}`);
  if (!ENT.includes(entity)) fail("Choose what you are importing.");
  const text = await csvText(f);
  const v = validateImport(entity, text);
  if (v.fatal) fail(v.fatal);

  const supabase = await createClient();
  const { data: t } = await supabase.from("tenants").select("id").eq("slug", slug).maybeSingle();
  if (!t) fail("Workspace not found.");
  const { data, error } = await supabase.rpc("import_rows", { p_tenant: t!.id, p_entity: entity, p_rows: v.rows });
  if (error) fail(friendlyError(error.message));
  const res = data as { total: number; imported: number; failed: { row: number; error: string }[] };
  const problems = [...v.problems, ...res.failed.map((x) => ({ row: x.row, error: importError(x.error) }))].sort((a, b) => a.row - b.row);
  const q = new URLSearchParams({ imported: String(res.imported), skipped: String(problems.length), entity });
  if (problems.length) q.set("problems", JSON.stringify(problems.slice(0, 200)));
  redirect(`/w/${slug}/data?${q.toString()}`);
}
