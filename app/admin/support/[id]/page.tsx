import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { currentUser } from "@/lib/workspace";
import { Empty } from "@/components/ui";

export const metadata: Metadata = { title: "Support view" };
const UUID = /^[0-9a-f-]{36}$/i;

export default async function SupportView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await currentUser();
  if (!UUID.test(id)) notFound();
  const { data, error } = await (await createClient()).rpc("platform_support_summary", { p_tenant: id });
  if (error) {
    if (/no_support_grant/.test(error.message)) return <main className="mx-auto max-w-lg p-6"><h1 className="text-xl font-semibold">No active support access</h1><p className="mt-2 text-muted">The workspace owner hasn't granted access, or the grant has expired. Ask them to allow it in Settings.</p><a className="btn mt-4" href="/admin">Back</a></main>;
    notFound();
  }
  const s = data as Record<string, any>;
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Support view</h1>
      <p className="text-sm text-muted">Allowed because: “{s.grant_note}” until {new Date(s.expires_at).toLocaleString("en-IN")}. This view is recorded in the customer's audit trail. Counts only; no customer records are shown.</p>
      <dl className="grid gap-3 sm:grid-cols-3">{["members", "accounts", "leads", "opportunities", "pending_webhooks", "dead_webhooks"].map((k) => <div key={k} className="card"><dt className="text-sm text-muted">{k.replace("_", " ")}</dt><dd className="text-xl font-semibold">{s[k]}</dd></div>)}</dl>
      <h2 className="text-lg font-semibold">Recent activity</h2>
      {(s.recent_audit ?? []).length === 0 ? <Empty>None.</Empty> : <ul className="space-y-1 text-sm">{s.recent_audit.map((a: any, i: number) => <li key={i} className="card py-2"><span className="font-mono text-xs">{a.action}</span> <span className="text-muted">{new Date(a.at).toLocaleString("en-IN")}</span></li>)}</ul>}
      <a className="btn-quiet" href="/admin">Back</a>
    </main>
  );
}
