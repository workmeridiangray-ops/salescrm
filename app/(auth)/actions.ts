"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/routing";

export async function signIn(form: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: String(form.get("email") ?? "").trim(),
    password: String(form.get("password") ?? ""),
  });
  const next = safeNext(String(form.get("next") ?? ""));
  if (error) redirect(`/login?error=credentials&next=${encodeURIComponent(next)}`);
  redirect(next);
}

export async function signUp(form: FormData) {
  const supabase = await createClient();
  const next = safeNext(String(form.get("next") ?? ""));
  const { data, error } = await supabase.auth.signUp({
    email: String(form.get("email") ?? "").trim(),
    password: String(form.get("password") ?? ""),
    options: { data: { full_name: String(form.get("full_name") ?? "").trim() } },
  });
  if (error) redirect(`/login?error=signup&mode=signup&next=${encodeURIComponent(next)}`);
  if (!data.session) redirect("/login?notice=confirm");
  redirect(next);
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
