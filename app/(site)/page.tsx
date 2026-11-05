import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Sales CRM for B2B teams", description: "Leads, accounts, pipeline and follow-ups in one place, with every company's data kept separate." };

const POINTS = [
  ["Every lead accounted for", "Web form and manual leads land in one inbox, are de-duplicated, scored with stated reasons and shared out round-robin."],
  ["A pipeline that keeps its history", "Stage, value and owner changes are recorded automatically. Losing a deal needs a reason; reopening never rewrites the past."],
  ["Sellers know what to do today", "A daily queue of due follow-ups and deals that have no next step."],
  ["Your company's data stays yours", "Each workspace is isolated in the database itself, with roles and an audit trail of sensitive changes."],
];

export default function Home() {
  return (
    <div className="space-y-12">
      <section className="max-w-2xl space-y-4">
        <h1 className="text-4xl font-semibold tracking-tight">Sales CRM for teams that sell to businesses</h1>
        <p className="text-lg text-muted">Capture leads, qualify them, run opportunities through your pipeline and never miss a follow-up.</p>
        <div className="flex flex-wrap gap-3">
          <Link href="/login?mode=signup" className="btn">Start 14-day free trial</Link>
          <Link href="/demo" className="btn-quiet">Book a demo</Link>
        </div>
      </section>
      <section aria-label="Highlights" className="grid gap-4 sm:grid-cols-2">
        {POINTS.map(([t, d]) => <div key={t} className="card"><h2 className="font-semibold">{t}</h2><p className="mt-1 text-muted">{d}</p></div>)}
      </section>
    </div>
  );
}
