import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { friendlyError } from "@/lib/rules/permissions";
import { inr } from "@/lib/util";

export const metadata: Metadata = { title: "Your quote", robots: { index: false, follow: false } };

async function respond(form: FormData) {
  "use server";
  const token = String(form.get("token") ?? "");
  const accept = form.get("decision") === "accept";
  const { error } = await (await createClient()).rpc("respond_to_quote", {
    p_token: token, p_accept: accept, p_name: String(form.get("name") ?? ""), p_reason: String(form.get("reason") ?? ""),
  });
  redirect(`/quote/${encodeURIComponent(token)}${error ? `?error=${encodeURIComponent(friendlyError(error.message))}` : ""}`);
}

type View = { company: string; number: string; version: number; status: string; expired: boolean; valid_until: string; notes: string | null;
  discount_pct: number; subtotal: number; discount_total: number; tax_total: number; total: number; responded_by: string | null;
  lines: { description: string; qty: number; unit_price: number; tax_rate: number }[] };

export default async function QuoteReview({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string }> }) {
  const { token } = await params;
  const { error } = await searchParams;
  const { data } = await (await createClient()).rpc("quote_for_review", { p_token: token });
  const v = data as View | null;
  if (!v) return <main className="mx-auto max-w-md p-8"><h1 className="text-xl font-semibold">This link is no longer valid</h1><p className="mt-2 text-muted">The quote may have been replaced by a newer version. Ask the sender for the current link.</p></main>;
  const open = v.status === "sent" && !v.expired;
  return (
    <main className="mx-auto max-w-2xl space-y-5 p-6">
      <header><p className="text-sm text-muted">{v.company}</p><h1 className="text-2xl font-semibold">Quote {v.number} <span className="text-muted">v{v.version}</span></h1>
        <p className="text-sm text-muted">Valid until {v.valid_until}</p></header>
      {error && <p role="alert" className="rounded border border-line bg-surface p-3 text-sm text-red-700">{error}</p>}
      <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm">
        <thead className="border-b border-line text-muted"><tr><th className="p-3">Item</th><th className="p-3 text-right">Qty</th><th className="p-3 text-right">Price</th><th className="p-3 text-right">GST</th></tr></thead>
        <tbody>{v.lines.map((l, i) => <tr key={i} className="border-b border-line last:border-0"><td className="p-3">{l.description}</td><td className="p-3 text-right">{Number(l.qty)}</td><td className="p-3 text-right">{inr(l.unit_price)}</td><td className="p-3 text-right">{Number(l.tax_rate)}%</td></tr>)}</tbody></table></div>
      <dl className="card ml-auto max-w-sm space-y-1 text-sm">
        <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd>{inr(v.subtotal)}</dd></div>
        {v.discount_total > 0 && <div className="flex justify-between"><dt className="text-muted">Discount ({Number(v.discount_pct)}%)</dt><dd>-{inr(v.discount_total)}</dd></div>}
        <div className="flex justify-between"><dt className="text-muted">GST</dt><dd>{inr(v.tax_total)}</dd></div>
        <div className="flex justify-between border-t border-line pt-1 font-semibold"><dt>Total</dt><dd>{inr(v.total)}</dd></div>
      </dl>
      {v.notes && <p className="text-sm">{v.notes}</p>}
      {open ? (
        <form action={respond} className="card space-y-3">
          <input type="hidden" name="token" value={token} />
          <label className="block text-sm font-medium">Your name<input className="input mt-1" name="name" required maxLength={160} autoComplete="name" /></label>
          <label className="block text-sm font-medium">Comment (optional)<input className="input mt-1" name="reason" maxLength={500} /></label>
          <div className="flex gap-3"><button className="btn" name="decision" value="accept">Accept quote</button><button className="btn-quiet" name="decision" value="decline">Decline</button></div>
        </form>
      ) : (
        <p role="status" className="card">{v.status === "accepted" ? `Accepted${v.responded_by ? ` by ${v.responded_by}` : ""}. Thank you.` : v.status === "rejected" ? "This quote was declined." : "This quote has expired. Please ask for a revised quote."}</p>
      )}
    </main>
  );
}
