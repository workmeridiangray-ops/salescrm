import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Features" };

const AVAILABLE = [
  ["Accounts and contacts", "Company and person records with owners, search, duplicate protection and a timeline of calls, meetings and notes."],
  ["Lead inbox", "Web form and manual leads, explainable scoring, round-robin assignment, qualify, disqualify with a reason, and one-click conversion that links existing records."],
  ["Pipeline", "Board view with weighted value, required loss reasons, next actions and an automatic history of stage, value and owner changes."],
  ["Today", "Due and overdue follow-ups and opportunities without a next action."],
  ["Teams and access", "Invitations, roles with a permission matrix, suspension, ownership-based visibility and an audit trail."],
];
const COMING = ["Email sync and outreach sequences", "Meetings and booking links", "Quotes, discounts and approvals", "Forecasting and targets", "CSV import and export", "Reports and webhooks"];

export default function Features() {
  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-semibold">Features</h1>
      <section aria-labelledby="avail"><h2 id="avail" className="text-xl font-semibold">Available now</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">{AVAILABLE.map(([t, d]) => <div key={t} className="card"><h3 className="font-semibold">{t}</h3><p className="mt-1 text-muted">{d}</p></div>)}</div></section>
      <section aria-labelledby="soon"><h2 id="soon" className="text-xl font-semibold">On the roadmap</h2>
        <ul className="mt-3 list-disc pl-5 text-muted">{COMING.map((c) => <li key={c}>{c}</li>)}</ul></section>
      <Link href="/login?mode=signup" className="btn">Start free trial</Link>
    </div>
  );
}
