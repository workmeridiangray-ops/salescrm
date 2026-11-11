import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/rules/permissions";
import { QUOTE_STATUS_LABEL, effectiveStatus } from "@/lib/rules/quote";
import { getWorkspace } from "@/lib/workspace";
import { Badge, Hidden, Notice } from "@/components/ui";
import { inr, one } from "@/lib/util";
import { addLine, approveQuote, rejectApproval, removeLine, reviseQuote, saveTerms, sendQuote, submitQuote } from "../actions";

export const metadata: Metadata = { title: "Quote" };

export default async function QuoteDetail({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug, id } = await params;
  const sp = await searchParams;
  const { tenant, perms } = await getWorkspace(slug);
  const supabase = await createClient();
  const { data: q } = await supabase.from("quotes").select("*, opportunities(name)").eq("id", id).eq("tenant_id", tenant.id).maybeSingle();
  if (!q) notFound();
  const [{ data: lines }, { data: products }] = await Promise.all([
    supabase.from("quote_lines").select("id, description, qty, unit_price, tax_rate").eq("quote_id", id).order("position").order("id"),
    supabase.from("products").select("id, name, unit_price").eq("tenant_id", tenant.id).eq("active", true).order("name").limit(500),
  ]);
  const st = effectiveStatus(q.status, q.valid_until);
  const draft = q.status === "draft";
  const approver = can(perms, "quotes.approve");
  const hid = (
    <><Hidden name="slug" value={slug} /><Hidden name="quote" value={id} /></>
  );
  const reviewLink = sp.link ? `${(process.env.APP_URL ?? "").replace(/\/$/, "")}/quote/${sp.link}` : null;
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><h1 className="text-2xl font-semibold">{q.number} <span className="text-muted">v{q.version}</span></h1>
          <p className="text-muted">{one(q.opportunities as { name: string } | { name: string }[] | null)?.name}</p></div>
        <Badge tone={st === "accepted" ? "green" : st === "rejected" || st === "expired" ? "red" : st === "pending_approval" ? "amber" : "blue"}>{QUOTE_STATUS_LABEL[st] ?? st}</Badge>
      </div>
      <Notice error={sp.error} ok={sp.ok} />
      {reviewLink && <p role="status" className="rounded border border-line bg-surface p-3 text-sm">Customer review link (shown once, share it with your customer):<code className="mt-1 block break-all">{reviewLink}</code></p>}
      {q.decision_reason && <p className="text-sm text-muted">Note: {q.decision_reason}{q.responded_by_name ? ` — ${q.responded_by_name}` : ""}</p>}

      <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm">
        <thead className="border-b border-line text-muted"><tr><th className="p-3">Item</th><th className="p-3 text-right">Qty</th><th className="p-3 text-right">Price</th><th className="p-3 text-right">GST</th>{draft && <th className="p-3" />}</tr></thead>
        <tbody>{(lines ?? []).map((l) => (
          <tr key={l.id} className="border-b border-line last:border-0"><td className="p-3">{l.description}</td><td className="p-3 text-right tabular-nums">{Number(l.qty)}</td>
            <td className="p-3 text-right tabular-nums">{inr(l.unit_price)}</td><td className="p-3 text-right tabular-nums">{Number(l.tax_rate)}%</td>
            {draft && <td className="p-3"><form action={removeLine}>{hid}<Hidden name="line" value={l.id} /><button className="btn-quiet">Remove</button></form></td>}</tr>))}
          {(lines ?? []).length === 0 && <tr><td className="p-3 text-muted" colSpan={5}>No lines yet.</td></tr>}</tbody></table></div>

      <dl className="card ml-auto max-w-sm space-y-1 text-sm">
        {[["Subtotal", q.subtotal], [`Discount (${Number(q.discount_pct)}%)`, `-${q.discount_total}`], ["GST", q.tax_total]].map(([k, v]) => (
          <div key={String(k)} className="flex justify-between"><dt className="text-muted">{k}</dt><dd className="tabular-nums">{String(v).startsWith("-") ? `-${inr(String(v).slice(1))}` : inr(v as string)}</dd></div>))}
        <div className="flex justify-between border-t border-line pt-1 font-semibold"><dt>Total</dt><dd className="tabular-nums">{inr(q.total)}</dd></div>
      </dl>

      {draft && (<>
        <form action={addLine} className="card flex flex-wrap items-end gap-3">
          {hid}<Hidden name="tenant" value={tenant.id} />
          <label className="text-sm font-medium">Product<select className="input mt-1" name="product"><option value="">Custom item</option>{(products ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} ({inr(p.unit_price)})</option>)}</select></label>
          <label className="text-sm font-medium">Description<input className="input mt-1" name="description" /></label>
          <label className="text-sm font-medium">Qty<input className="input mt-1 w-24" type="number" step="0.001" min="0.001" name="qty" defaultValue="1" /></label>
          <label className="text-sm font-medium">Price (₹)<input className="input mt-1 w-28" type="number" step="0.01" min="0" name="unit_price" /></label>
          <label className="text-sm font-medium">GST %<input className="input mt-1 w-20" type="number" step="0.01" min="0" max="100" name="tax_rate" defaultValue="18" /></label>
          <button className="btn">Add line</button>
        </form>
        <form action={saveTerms} className="card flex flex-wrap items-end gap-3">
          {hid}
          <label className="text-sm font-medium">Discount %<input className="input mt-1 w-28" type="number" step="0.01" min="0" max="100" name="discount_pct" defaultValue={Number(q.discount_pct)} /></label>
          <label className="text-sm font-medium">Valid until<input className="input mt-1" type="date" name="valid_until" defaultValue={q.valid_until} required /></label>
          <label className="text-sm font-medium">Notes to customer<input className="input mt-1 w-72" name="notes" defaultValue={q.notes ?? ""} maxLength={2000} /></label>
          <button className="btn-quiet">Save</button>
        </form>
        <form action={submitQuote}>{hid}<button className="btn">Submit {Number(q.discount_pct) > 0 ? "(may need approval)" : ""}</button></form>
      </>)}

      {q.status === "pending_approval" && (approver
        ? <div className="card flex flex-wrap items-end gap-3"><form action={approveQuote}>{hid}<button className="btn">Approve</button></form>
            <form action={rejectApproval} className="flex gap-2">{hid}<input className="input w-64" name="reason" placeholder="Reason for sending back" required aria-label="Reason" /><button className="btn-quiet">Send back</button></form></div>
        : <p className="text-muted">Waiting for an approver. Discounts of {Number(q.discount_pct)}% need approval.</p>)}
      {q.status === "approved" && <form action={sendQuote}>{hid}<button className="btn">Send to customer</button></form>}
      {["sent", "rejected", "expired", "approved", "pending_approval", "accepted"].includes(q.status) && (
        <form action={reviseQuote} className="flex items-center gap-3">{hid}<button className="btn-quiet">Create revision</button>
          {q.status === "accepted" && <span className="text-sm text-muted">Revising an accepted quote needs an approver.</span>}</form>)}
    </section>
  );
}
