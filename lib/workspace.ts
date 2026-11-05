import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { can, type Permission } from "@/lib/rules/permissions";

export const currentUser = cache(async () => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return user;
});

/**
 * Loads a workspace by its address for the signed-in user. RLS returns nothing
 * for workspaces they don't belong to, so a guessed slug looks the same as a
 * missing one; both lead to access-denied, never to another tenant's data.
 */
export const getWorkspace = cache(async (slug: string) => {
  const user = await currentUser();
  const supabase = await createClient();
  const { data: tenant } = await supabase.from("tenants").select("id, name, slug, status").eq("slug", slug).maybeSingle();
  if (!tenant) redirect("/access-denied");
  const { data: me } = await supabase
    .from("memberships")
    .select("status, roles(key, name, permissions)")
    .eq("tenant_id", tenant.id).eq("user_id", user.id).maybeSingle();
  const role = (Array.isArray(me?.roles) ? me?.roles[0] : me?.roles) as { key: string; name: string; permissions: string[] } | undefined;
  if (!me || !role) redirect("/access-denied");
  return { user, tenant, role, perms: role.permissions };
});

export async function requirePermission(slug: string, p: Permission) {
  const ws = await getWorkspace(slug);
  if (!can(ws.perms, p)) notFound();
  return ws;
}
