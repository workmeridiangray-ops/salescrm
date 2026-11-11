"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const num = (f: FormData, k: string) => Number(s(f, k));

function go(slug: string, path: string, error: { message: string } | null, ok?: string): never {
  revalidatePath(`/w/${slug}`, "layout");
  const sep = path.includes("?") ? "&" : "?";
  redirect(`/w/${slug}/${path}${error ? `${sep}error=${encodeURIComponent(friendlyError(error.message))}` : ok ? `${sep}ok=${encodeURIComponent(ok)}` : ""}`);
}

export async function createQuote(f: FormData) {
  const { data, error } = await (await createClient()).rpc("create_quote", { p_opportunity: s(f, "opportunity"), p_valid_days: num(f, "days") || 30 });
  if (error) go(s(f, "slug"), "quotes", error);
  redirect(`/w/${s(f, "slug")}/quotes/${data}`);
}

export async function addLine(f: FormData) {
  const supabase = await createClient();
  const slug = s(f, "slug"), qid = s(f, "quote");
  let row = { description: s(f, "description"), unit_price: num(f, "unit_price"), tax_rate: f.get("tax_rate") === null || s(f, "tax_rate") === "" ? 18 : num(f, "tax_rate"), product_id: null as string | null };
  const pid = s(f, "product");
  if (pid) {
    const { data: p } = await supabase.from("products").select("id, name, unit_price, tax_rate").eq("id", pid).maybeSingle();
    if (p) row = { description: row.description || p.name, unit_price: row.unit_price || Number(p.unit_price), tax_rate: Number(p.tax_rate), product_id: p.id };
  }
  const { error } = await supabase.from("quote_lines").insert({ tenant_id: s(f, "tenant"), quote_id: qid, qty: num(f, "qty") || 1, ...row });
  go(slug, `quotes/${qid}`, error);
}

export async function removeLine(f: FormData) {
  const { error } = await (await createClient()).from("quote_lines").delete().eq("id", s(f, "line"));
  go(s(f, "slug"), `quotes/${s(f, "quote")}`, error);
}

export async function saveTerms(f: FormData) {
  const { error } = await (await createClient()).from("quotes")
    .update({ discount_pct: num(f, "discount_pct") || 0, valid_until: s(f, "valid_until"), notes: s(f, "notes") || null }).eq("id", s(f, "quote")).select("id").single();
  go(s(f, "slug"), `quotes/${s(f, "quote")}`, error, "Saved");
}

async function call(f: FormData, name: string, ok: string, extra: Record<string, unknown> = {}) {
  const { error } = await (await createClient()).rpc(name, { p_quote: s(f, "quote"), ...extra });
  go(s(f, "slug"), `quotes/${s(f, "quote")}`, error, ok);
}
export async function submitQuote(f: FormData) { await call(f, "submit_quote", "Submitted"); }
export async function approveQuote(f: FormData) { await call(f, "approve_quote", "Approved"); }
export async function rejectApproval(f: FormData) { await call(f, "reject_quote_approval", "Returned to draft", { p_reason: s(f, "reason") }); }

export async function sendQuote(f: FormData) {
  const slug = s(f, "slug"), qid = s(f, "quote");
  const { data, error } = await (await createClient()).rpc("send_quote", { p_quote: qid });
  if (error) go(slug, `quotes/${qid}`, error);
  // Shown once. Email delivery to the customer comes with the email-sync work.
  redirect(`/w/${slug}/quotes/${qid}?link=${encodeURIComponent(String(data))}`);
}

export async function reviseQuote(f: FormData) {
  const slug = s(f, "slug");
  const { data, error } = await (await createClient()).rpc("revise_quote", { p_quote: s(f, "quote") });
  if (error) go(slug, `quotes/${s(f, "quote")}`, error);
  redirect(`/w/${slug}/quotes/${data}?ok=${encodeURIComponent("New version created")}`);
}

export async function setThreshold(f: FormData) {
  const { error } = await (await createClient()).rpc("set_discount_threshold", { p_tenant: s(f, "tenant"), p_pct: num(f, "pct") });
  go(s(f, "slug"), "quotes", error, "Threshold saved");
}

export async function addProduct(f: FormData) {
  const { error } = await (await createClient()).from("products").insert({
    tenant_id: s(f, "tenant"), sku: s(f, "sku") || null, name: s(f, "name"), unit_price: num(f, "unit_price"), tax_rate: s(f, "tax_rate") === "" ? 18 : num(f, "tax_rate"),
  });
  go(s(f, "slug"), "products", error, "Product added");
}

export async function toggleProduct(f: FormData) {
  const { error } = await (await createClient()).from("products").update({ active: s(f, "active") === "true" }).eq("id", s(f, "id")).select("id").single();
  go(s(f, "slug"), "products", error);
}
