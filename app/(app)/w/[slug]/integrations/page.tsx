import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { EVENTS, SCOPES } from "@/lib/api-keys";
import { requirePermission } from "@/lib/workspace";
import { Badge, Empty, Hidden, Notice } from "@/components/ui";
import { createHook, createKey, retryDelivery, revokeKey, toggleHook } from "./actions";

export const metadata: Metadata = { title: "Integrations" };

export default async function Integrations({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant } = await requirePermission(slug, "api.manage");
  const supabase = await createClient();
  const [{ data: keys }, { data: hooks }, { data: deliveries }] = await Promise.all([
    supabase.from("api_keys").select("id, name, key_prefix, scopes, last_used_at, revoked_at, created_at").eq("tenant_id", tenant.id).order("created_at", { ascending: false }),
    supabase.from("webhook_endpoints").select("id, url, events, active").eq("tenant_id", tenant.id).order("created_at"),
    supabase.from("webhook_deliveries").select("id, event, status, attempts, last_error, response_status, next_attempt_at, created_at").eq("tenant_id", tenant.id).order("id", { ascending: false }).limit(30),
  ]);
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const hid = <><Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} /></>;
  return (
    <section className="space-y-8">
      <h1 className="text-2xl font-semibold">Integrations</h1>
      <Notice error={sp.error} ok={sp.ok} />
      {sp.newkey && <p role="status" className="rounded border border-line bg-surface p-3 text-sm">New API key — copy it now, it won't be shown again:<code className="mt-1 block break-all">{sp.newkey}</code></p>}
      {sp.newsecret && <p role="status" className="rounded border border-line bg-surface p-3 text-sm">Signing secret — copy it now, it won't be shown again:<code className="mt-1 block break-all">{sp.newsecret}</code></p>}

      <div className="space-y-3"><h2 className="text-lg font-semibold">API keys</h2>
        <p className="text-sm text-muted">Keys read the whole workspace regardless of who created them, so grant only what an integration needs. Requests are limited to 120 per minute per key. Example: <code>curl -H "Authorization: Bearer sk_live_…" {base || "https://your-app"}/api/v1/accounts?limit=50</code>. Use the <code>next</code> value as <code>?after=</code> for the following page. <code>POST /api/v1/leads</code> with a JSON body adds a lead (repeating it is safe: duplicates merge).</p>
        {(keys ?? []).length === 0 ? <Empty>No API keys.</Empty> : (
          <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm"><thead className="border-b border-line text-muted"><tr><th className="p-3">Name</th><th className="p-3">Key</th><th className="p-3">Permissions</th><th className="p-3">Last used</th><th className="p-3" /></tr></thead>
            <tbody>{(keys ?? []).map((k) => (
              <tr key={k.id} className="border-b border-line last:border-0"><td className="p-3 font-medium">{k.name}</td><td className="p-3 font-mono text-xs">{k.key_prefix}…</td><td className="p-3">{(k.scopes as string[]).join(", ")}</td>
                <td className="p-3">{k.last_used_at ? new Date(k.last_used_at).toLocaleString("en-IN") : "never"}</td>
                <td className="p-3">{k.revoked_at ? <Badge tone="red">Revoked</Badge> : <form action={revokeKey}>{hid}<Hidden name="id" value={k.id} /><button className="btn-quiet">Revoke</button></form>}</td></tr>))}</tbody></table></div>)}
        <form action={createKey} className="card space-y-3">{hid}
          <label className="block text-sm font-medium">Name<input className="input mt-1 max-w-xs" name="name" required maxLength={80} placeholder="Website form" /></label>
          <fieldset className="flex flex-wrap gap-4 text-sm"><legend className="mb-1 font-medium">Permissions</legend>{SCOPES.map((sc) => <label key={sc}><input type="checkbox" name="scope" value={sc} /> {sc}</label>)}</fieldset>
          <button className="btn">Create key</button></form>
      </div>

      <div className="space-y-3"><h2 className="text-lg font-semibold">Webhooks</h2>
        <p className="text-sm text-muted">We POST JSON to your https address when an event happens. Verify <code>X-Webhook-Signature</code> = <code>sha256=HMAC_SHA256(secret, timestamp + "." + body)</code> using <code>X-Webhook-Timestamp</code>, and reject old timestamps. Failed deliveries retry after 1 min, 5 min, 30 min, 2 h and 12 h, then stop; you can retry them below. Delivery needs the scheduler described in the README.</p>
        {(hooks ?? []).length === 0 ? <Empty>No webhooks.</Empty> : (
          <ul className="space-y-2">{(hooks ?? []).map((h) => (
            <li key={h.id} className="card flex flex-wrap items-center justify-between gap-2 text-sm"><span><span className="font-medium break-all">{h.url}</span><br /><span className="text-muted">{(h.events as string[]).join(", ")}</span></span>
              <form action={toggleHook} className="flex items-center gap-2">{hid}<Hidden name="id" value={h.id} /><Hidden name="active" value={String(!h.active)} />
                <Badge tone={h.active ? "green" : "grey"}>{h.active ? "Active" : "Paused"}</Badge><button className="btn-quiet">{h.active ? "Pause" : "Resume"}</button></form></li>))}</ul>)}
        <form action={createHook} className="card space-y-3">{hid}
          <label className="block text-sm font-medium">Endpoint URL<input className="input mt-1" type="url" name="url" required placeholder="https://example.com/crm-webhook" /></label>
          <fieldset className="flex flex-wrap gap-4 text-sm"><legend className="mb-1 font-medium">Events</legend>{EVENTS.map((e) => <label key={e}><input type="checkbox" name="event" value={e} defaultChecked /> {e}</label>)}</fieldset>
          <button className="btn">Add webhook</button></form>
        <h3 className="font-semibold">Recent deliveries</h3>
        {(deliveries ?? []).length === 0 ? <Empty>No deliveries yet.</Empty> : (
          <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm"><thead className="border-b border-line text-muted"><tr><th className="p-3">When</th><th className="p-3">Event</th><th className="p-3">Status</th><th className="p-3">Attempts</th><th className="p-3">Last error</th><th className="p-3" /></tr></thead>
            <tbody>{(deliveries ?? []).map((d) => (
              <tr key={d.id} className="border-b border-line last:border-0"><td className="p-3 whitespace-nowrap">{new Date(d.created_at).toLocaleString("en-IN")}</td><td className="p-3 font-mono text-xs">{d.event}</td>
                <td className="p-3"><Badge tone={d.status === "delivered" ? "green" : d.status === "dead" ? "red" : "amber"}>{d.status}</Badge></td><td className="p-3">{d.attempts}</td><td className="p-3 text-muted">{d.last_error ?? "—"}</td>
                <td className="p-3">{d.status === "dead" && <form action={retryDelivery}>{hid}<Hidden name="id" value={String(d.id)} /><button className="btn-quiet">Retry</button></form>}</td></tr>))}</tbody></table></div>)}
      </div>
    </section>
  );
}
