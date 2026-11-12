export type ReportKey = "lead_sources" | "funnel" | "sales_cycle" | "stage_ageing" | "seller_performance" | "losses";
export type Col = { key: string; label: string; kind?: "text" | "int" | "money" | "days" | "pct" | "person" };
export type ReportDef = { key: ReportKey; title: string; fn: string; ranged: boolean; note: string; columns: Col[] };

export const REPORTS: ReportDef[] = [
  { key: "lead_sources", title: "Lead sources", fn: "report_lead_sources", ranged: true,
    note: "Leads created in the period, by where they came from.",
    columns: [{ key: "source", label: "Source" }, { key: "leads", label: "Leads", kind: "int" }, { key: "qualified", label: "Qualified", kind: "int" },
      { key: "converted", label: "Converted", kind: "int" }, { key: "disqualified", label: "Disqualified", kind: "int" }, { key: "conversion", label: "Conversion", kind: "pct" }] },
  { key: "funnel", title: "Pipeline funnel", fn: "report_funnel", ranged: true,
    note: "Opportunities that entered each stage during the period.",
    columns: [{ key: "stage", label: "Stage" }, { key: "entered", label: "Entered", kind: "int" }] },
  { key: "sales_cycle", title: "Sales cycle", fn: "report_sales_cycle", ranged: true,
    note: "Days from creation to won, for deals won in the period.",
    columns: [{ key: "owner_id", label: "Seller", kind: "person" }, { key: "won", label: "Deals won", kind: "int" }, { key: "avg_days", label: "Average", kind: "days" }, { key: "median_days", label: "Median", kind: "days" }] },
  { key: "stage_ageing", title: "Stage ageing", fn: "report_stage_ageing", ranged: false,
    note: "How long open deals have sat in their current stage (as of now).",
    columns: [{ key: "stage", label: "Stage" }, { key: "open_deals", label: "Open deals", kind: "int" }, { key: "avg_days", label: "Average age", kind: "days" }, { key: "max_days", label: "Oldest", kind: "days" }] },
  { key: "seller_performance", title: "Seller performance", fn: "report_seller_performance", ranged: true,
    note: "Outcomes first. Completed activities are context, not a score.",
    columns: [{ key: "owner_id", label: "Seller", kind: "person" }, { key: "won_count", label: "Won", kind: "int" }, { key: "won_amount", label: "Won value", kind: "money" },
      { key: "lost_count", label: "Lost", kind: "int" }, { key: "win_rate", label: "Win rate", kind: "pct" }, { key: "open_amount", label: "Open pipeline", kind: "money" },
      { key: "no_next_action", label: "No next action", kind: "int" }, { key: "activities_done", label: "Activities done", kind: "int" }] },
  { key: "losses", title: "Lost deals", fn: "report_losses", ranged: true,
    note: "Why deals were lost, in the period.",
    columns: [{ key: "reason", label: "Reason" }, { key: "deals", label: "Deals", kind: "int" }, { key: "amount", label: "Value", kind: "money" }] },
];
export const reportByKey = (k: string | undefined) => REPORTS.find((r) => r.key === k) ?? REPORTS[0]!;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s: string | undefined): s is string => !!s && DATE.test(s) && !Number.isNaN(Date.parse(s));
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Default is the last 90 days; invalid or reversed input falls back safely; capped at 2 years. */
export function parseRange(from?: string, to?: string, now = new Date()): { from: string; to: string } {
  const end = isDate(to) ? to : isoDay(now);
  let start = isDate(from) ? from : isoDay(new Date(new Date(end).getTime() - 90 * 86400000));
  if (start > end) start = end;
  const floor = isoDay(new Date(new Date(end).getTime() - 730 * 86400000));
  if (start < floor) start = floor;
  return { from: start, to: end };
}

/** Add derived columns (rates) that the database leaves to the presentation layer. */
export function enrich(key: ReportKey, rows: Record<string, any>[]): Record<string, any>[] {
  if (key === "lead_sources") return rows.map((r) => ({ ...r, conversion: r.leads ? r.converted / r.leads : 0 }));
  if (key === "seller_performance") return rows.map((r) => ({ ...r, win_rate: r.won_count + r.lost_count ? r.won_count / (r.won_count + r.lost_count) : null }));
  return rows;
}

export function formatCell(kind: Col["kind"], v: unknown, people: Map<string, string>): string {
  if (v === null || v === undefined || v === "") return "—";
  switch (kind) {
    case "int": return String(Number(v));
    case "money": return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(v));
    case "days": return `${Number(v)} d`;
    case "pct": return `${Math.round(Number(v) * 100)}%`;
    case "person": return people.get(String(v)) ?? "Unassigned";
    default: return String(v);
  }
}
