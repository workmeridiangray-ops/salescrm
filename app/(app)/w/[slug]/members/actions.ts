"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";

type Result = { error: { message: string } | null };

async function done(slug: string, res: Result, extra = "") {
  if (res.error) redirect(`/w/${slug}/members?error=${encodeURIComponent(friendlyError(res.error.message))}`);
  revalidatePath(`/w/${slug}/members`);
  redirect(`/w/${slug}/members${extra}`);
}

const s = (f: FormData, k: string) => String(f.get(k) ?? "");

export async function invite(form: FormData) {
  const slug = s(form, "slug");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("invite_member", { p_tenant: s(form, "tenant"), p_email: s(form, "email"), p_role: s(form, "role") });
  if (error) return done(slug, { error });
  // No email service yet (Phase 8): show the one-time link to the inviter.
  await done(slug, { error: null }, `?invite=${encodeURIComponent(String(data))}`);
}

export async function revokeInvitation(form: FormData) {
  const supabase = await createClient();
  await done(s(form, "slug"), await supabase.rpc("revoke_invitation", { p_tenant: s(form, "tenant"), p_invitation: s(form, "id") }));
}

export async function changeRole(form: FormData) {
  const supabase = await createClient();
  await done(s(form, "slug"), await supabase.rpc("change_member_role", { p_tenant: s(form, "tenant"), p_user: s(form, "user"), p_role: s(form, "role") }));
}

export async function setStatus(form: FormData) {
  const supabase = await createClient();
  await done(s(form, "slug"), await supabase.rpc("set_member_status", { p_tenant: s(form, "tenant"), p_user: s(form, "user"), p_status: s(form, "status") }));
}

export async function removeMember(form: FormData) {
  const supabase = await createClient();
  await done(s(form, "slug"), await supabase.rpc("remove_member", { p_tenant: s(form, "tenant"), p_user: s(form, "user") }));
}
