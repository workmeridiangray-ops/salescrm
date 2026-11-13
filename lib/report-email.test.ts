import { describe, expect, it } from "vitest";
import { buildReportEmail } from "./report-email";
import { reportByKey } from "./reports";

const people = new Map([["u1", "Asha <script>"]]);
describe("buildReportEmail", () => {
  it("renders rows, escapes names and shows the period", () => {
    const def = reportByKey("seller_performance");
    const m = buildReportEmail(def, [{ owner_id: "u1", won_count: 2, won_amount: 150000, lost_count: 1, win_rate: 2 / 3, open_amount: 0, no_next_action: 1, activities_done: 9 }],
      { workspace: "Acme", from: "2026-11-01", to: "2026-11-30", people, link: "https://app.test/w/acme/reports" });
    expect(m.subject).toBe("Seller performance — Acme (2026-11-01 to 2026-11-30)");
    expect(m.html).toContain("Asha &lt;script&gt;");
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("67%");
    expect(m.text).toContain("Won value:");
  });
  it("says so when there is nothing, and uses 'as of today' for point-in-time reports", () => {
    const m = buildReportEmail(reportByKey("stage_ageing"), [], { workspace: "Acme", from: "", to: "", people, link: "https://x.test" });
    expect(m.html).toContain("Nothing to report for this period.");
    expect(m.subject).toContain("as of today");
  });
  it("strips line breaks from a hostile workspace name in the subject", () => {
    expect(buildReportEmail(reportByKey("losses"), [], { workspace: "A\r\nBcc: x@y.z", from: "a", to: "b", people, link: "x" }).subject).not.toMatch(/[\r\n]/);
  });
});
