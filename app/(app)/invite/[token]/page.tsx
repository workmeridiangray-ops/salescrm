import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";
import { currentUser } from "@/lib/workspace";

export const metadata: Metadata = { title: "Invitation" };

async function accept(form: FormData) {
  "use server";
  const token = String(form.get("token") ?? "");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("accept_invitation", { p_token: token });
  if (error) redirect(`/invite/${encodeURIComponent(token)}?error=${encodeURIComponent(friendlyError(error.message))}`);
  const { data: t } = await supabase.from("tenants").select("slug").eq("id", data).maybeSingle();
  redirect(t ? `/w/${t.slug}` : "/workspaces");
}

export default async function Invite({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string }> }) {
  const { token } = await params;
  const { error } = await searchParams;
  const user = await currentUser();
  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-xl font-semibold">Join a workspace</h1>
      <p className="mt-2 text-muted">You're signed in as {user.email}. The invitation must have been sent to this address.</p>
      {error && <p role="alert" className="mt-4 rounded border border-line bg-surface p-3 text-sm text-red-700">{error}</p>}
      <form action={accept} className="mt-4">
        <input type="hidden" name="token" value={token} />
        <button className="btn">Accept invitation</button>
      </form>
    </main>
  );
}
