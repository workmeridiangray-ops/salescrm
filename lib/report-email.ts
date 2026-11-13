import { escapeHtml } from "./email-templates";
import { type ReportDef, formatCell } from "./reports";

/** HTML + plain-text email for a scheduled report. Values are escaped; people are shown by name or email. */
export function buildReportEmail(def: ReportDef, rows: Record<string, any>[], opts: { workspace: string; from: string; to: string; people: Map<string, string>; link: string }) {
  const th = def.columns.map((c) => `<th style="text-align:left;padding:6px 10px;border-bottom:1px solid #D9DFE7">${escapeHtml(c.label)}</th>`).join("");
  const body = rows.length === 0
    ? `<tr><td style="padding:10px" colspan="${def.columns.length}">Nothing to report for this period.</td></tr>`
    : rows.map((r) => `<tr>${def.columns.map((c) => `<td style="padding:6px 10px;border-bottom:1px solid #eef1f5">${escapeHtml(formatCell(c.kind, r[c.key], opts.people))}</td>`).join("")}</tr>`).join("");
  const period = def.ranged ? `${opts.from} to ${opts.to}` : "as of today";
  const subject = `${def.title} — ${opts.workspace} (${period})`.replace(/[\r\n]+/g, " ");
  const html = `<h2 style="font-family:sans-serif">${escapeHtml(def.title)}</h2><p style="font-family:sans-serif;color:#526174">${escapeHtml(opts.workspace)} · ${escapeHtml(period)}</p>` +
    `<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>` +
    `<p style="font-family:sans-serif;font-size:12px;color:#526174">Calculated from recorded CRM data. <a href="${escapeHtml(opts.link)}">Open the report</a>. You get this because a workspace owner scheduled it.</p>`;
  const text = `${def.title} - ${opts.workspace} (${period})\n\n` + (rows.length === 0 ? "Nothing to report." : rows.map((r) => def.columns.map((c) => `${c.label}: ${formatCell(c.kind, r[c.key], opts.people)}`).join(" | ")).join("\n")) + `\n\n${opts.link}`;
  return { subject, html, text };
}
