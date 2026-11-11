import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/rules/permissions";
import { currentPeriod, isPeriod, shiftPeriod } from "@/lib/rules/quote";
import { getWorkspace } from "@/lib/workspace";
import { Badge, Empty, Hidden, Notice } from "@/components/ui";
import { inr, one } from "@/lib/util";
import { setOverride, setTarget, takeSnapshot } from "./actions";

export const metadata: Metadata = { title: "Forecast" };
type Row = { owner_id: string | null; commit_amount: number; best_case_amount: number; pipeline_amount: number; weighted: number; won: number; open_count: number };
const n = (x: unknown) => Number(x ?? 0);

export default async function Forecast({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant, perms } = await getWorkspace(slug);
  const period = sp.period && isPeriod(sp.period) ? sp.period : currentPeriod();
  const manage = can(perms, "forecast.manage");
  const today = new Date().toISOString().slice(0, 10);
  const supabase = await createClient();
  const [{ data: calc }, { data: targets }, { data: overrides }, { data: snaps }, { data: slipping }, { data: members }] = await Promise.all([
    supabase.rpc("forecast_rows", { p_tenant: tenant.id, p_period: period }),
    supabase.from("forecast_targets").select("owner_id, amount").eq("tenant_id", tenant.id).eq("period", period),
    supabase.from("forecast_overrides").select("owner_id, category, amount, reason, created_at").eq("tenant_id", tenant.id).eq("period", period).order("id", { ascending: false }),
    supabase.from("forecast_snapshots").select("id, taken_at, data").eq("tenant_id", tenant.id).eq("period", period).order("id", { ascending: false }).limit(10),
    supabase.from("opportunities").select("id, name, amount, expected_close, owner_id, next_action").eq("tenant_id", tenant.id).eq("status", "open").is("archived_at", null).lt("expected_close", today).order("expected_close").limit(50),
    supabase.from("memberships").select("user_id, profiles(email)").eq("tenant_id", tenant.id),
  ]);
  const name = new Map((members ?? []).map((m) => [m.user_id, one(m.profiles as { email: string } | { email: string }[] | null)?.email ?? m.user_id.slice(0, 8)]));
  const rows = (calc ?? []) as Row[];
  const latest = new Map<string, { amount: number; reason: string }>(); // newest override per owner|category
  for (const o of overrides ?? []) { const k = `${o.owner_id}|${o.category}`; if (!latest.has(k)) latest.set(k, { amount: n(o.amount), reason: o.reason }); }
  const eff = (r: Row, cat: "commit" | "best_case" | "pipeline") => latest.get(`${r.owner_id}|${cat}`)?.amount ?? n(cat === "commit" ? r.commit_amount : cat === "best_case" ? r.best_case_amount : r.pipeline_amount);
  const teamTarget = (targets ?? []).find((t) => t.owner_id === null);
  const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
  const commitTotal = sum((r) => eff(r, "commit")), wonTotal = sum((r) => n(r.won));
  const snap = (snaps ?? [])[0];
  const snapRows = ((snap?.data ?? []) as Row[]);
  const snapCommit = snapRows.reduce((a, r) => a + n(r.commit_amount), 0);
  const calcCommit = sum((r) => n(r.commit_amount));
  const hid = <><Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} /><Hidden name="period" value={period} /></>;
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Forecast {period}</h1>
        <nav aria-label="Period" className="flex gap-2"><a className="btn-quiet" href={`?period=${shiftPeriod(period, -1)}`}>Previous</a><a className="btn-quiet" href={`?period=${currentPeriod()}`}>This month</a><a className="btn-quiet" href={`?period=${shiftPeriod(period, 1)}`}>Next</a></nav>
      </div>
      <Notice error={sp.error} ok={sp.ok} />
      <div className="grid gap-3 sm:grid-cols-4">
        {[["Won", wonTotal], ["Commit", commitTotal], ["Target", n(teamTarget?.amount)], ["Coverage", n(teamTarget?.amount) ? `${Math.round(((wonTotal + commitTotal) / n(teamTarget?.amount)) * 100)}%` : "—"]].map(([k, v]) => (
          <div key={String(k)} className="card"><p className="text-sm text-muted">{k}</p><p className="text-xl font-semibold tabular-nums">{typeof v === "number" ? inr(v) : v}</p></div>))}
      </div>
      <p className="text-sm text-muted">Calculated from recorded opportunities (Commit ≥70% stage, Best case ≥40%, Pipeline below). Manager adjustments are shown separately and never overwrite the calculation. These are estimates, not predictions.</p>
      {rows.length === 0 ? <Empty>No open opportunities expected to close in {period}.</Empty> : (
        <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm">
          <thead className="border-b border-line text-muted"><tr><th className="p-3">Owner</th><th className="p-3 text-right">Won</th><th className="p-3 text-right">Commit (calc)</th><th className="p-3 text-right">Commit (adjusted)</th><th className="p-3 text-right">Best case</th><th className="p-3 text-right">Pipeline</th><th className="p-3 text-right">Weighted</th></tr></thead>
          <tbody>{rows.map((r) => { const ov = latest.get(`${r.owner_id}|commit`); return (
            <tr key={r.owner_id ?? "none"} className="border-b border-line last:border-0">
              <td className="p-3">{r.owner_id ? name.get(r.owner_id) ?? r.owner_id.slice(0, 8) : "Unassigned"}</td>
              <td className="p-3 text-right tabular-nums">{inr(n(r.won))}</td><td className="p-3 text-right tabular-nums">{inr(n(r.commit_amount))}</td>
              <td className="p-3 text-right tabular-nums">{ov ? <span title={ov.reason}>{inr(ov.amount)} <Badge tone="amber">adjusted</Badge></span> : "—"}</td>
              <td className="p-3 text-right tabular-nums">{inr(n(r.best_case_amount))}</td><td className="p-3 text-right tabular-nums">{inr(n(r.pipeline_amount))}</td><td className="p-3 text-right tabular-nums">{inr(n(r.weighted))}</td></tr>); })}</tbody></table></div>)}
      {manage && (
        <div className="grid gap-4 md:grid-cols-2">
          <form action={setTarget} className="card space-y-2">{hid}<h2 className="font-semibold">Target</h2>
            <label className="block text-sm font-medium">For<select className="input mt-1" name="owner"><option value="">Whole team</option>{[...name].map(([id, e]) => <option key={id} value={id}>{e}</option>)}</select></label>
            <label className="block text-sm font-medium">Amount (₹)<input className="input mt-1" type="number" min="0" step="0.01" name="amount" required /></label><button className="btn">Save target</button></form>
          <form action={setOverride} className="card space-y-2">{hid}<h2 className="font-semibold">Adjust a forecast</h2>
            <label className="block text-sm font-medium">Owner<select className="input mt-1" name="owner" required>{[...name].map(([id, e]) => <option key={id} value={id}>{e}</option>)}</select></label>
            <label className="block text-sm font-medium">Category<select className="input mt-1" name="category"><option value="commit">Commit</option><option value="best_case">Best case</option><option value="pipeline">Pipeline</option></select></label>
            <label className="block text-sm font-medium">Amount (₹)<input className="input mt-1" type="number" min="0" step="0.01" name="amount" required /></label>
            <label className="block text-sm font-medium">Reason<input className="input mt-1" name="reason" required /></label><button className="btn">Record adjustment</button></form>
        </div>)}
      <div><h2 className="text-lg font-semibold">Slipping deals</h2>
        {(slipping ?? []).length === 0 ? <Empty>No open deals are past their expected close date.</Empty> : (
          <ul className="mt-2 space-y-2">{(slipping ?? []).map((o) => (
            <li key={o.id} className="card flex flex-wrap justify-between gap-2 text-sm"><span className="font-medium">{o.name}</span>
              <span>{inr(o.amount)} · expected {o.expected_close} <Badge tone="red">overdue</Badge>{!o.next_action && <> <Badge tone="amber">no next action</Badge></>}</span></li>))}</ul>)}</div>
      <div><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Snapshots</h2>
        {manage && <form action={takeSnapshot}>{hid}<button className="btn-quiet">Take snapshot now</button></form>}</div>
        {snap ? <p className="mt-2 text-sm">Latest {new Date(snap.taken_at).toLocaleString("en-IN")}: commit was {inr(snapCommit)}, now {inr(calcCommit)} ({calcCommit - snapCommit >= 0 ? "+" : "-"}{inr(Math.abs(calcCommit - snapCommit))}).</p>
          : <Empty>No snapshots for this period yet.</Empty>}</div>
    </section>
  );
}
