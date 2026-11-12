import { describe, expect, it } from "vitest";
import { REPORTS, enrich, formatCell, parseRange, reportByKey } from "./reports";

const NOW = new Date("2026-11-12T10:00:00Z");
describe("parseRange", () => {
  it("defaults to the last 90 days", () => expect(parseRange(undefined, undefined, NOW)).toEqual({ from: "2026-08-14", to: "2026-11-12" }));
  it("keeps valid input, repairs reversed or garbage input, and caps at two years", () => {
    expect(parseRange("2026-01-01", "2026-02-01", NOW)).toEqual({ from: "2026-01-01", to: "2026-02-01" });
    expect(parseRange("2026-03-01", "2026-02-01", NOW)).toEqual({ from: "2026-02-01", to: "2026-02-01" });
    expect(parseRange("nope", "2026-13-45", NOW)).toEqual({ from: "2026-08-14", to: "2026-11-12" });
    expect(parseRange("2000-01-01", "2026-11-12", NOW).from).toBe("2024-11-12");
  });
});
describe("reports", () => {
  it("every report names a database function and has columns", () => {
    for (const r of REPORTS) { expect(r.fn).toMatch(/^report_/); expect(r.columns.length).toBeGreaterThan(0); }
    expect(reportByKey("nonsense").key).toBe("lead_sources");
  });
  it("derives conversion and win rate without dividing by zero", () => {
    expect(enrich("lead_sources", [{ leads: 4, converted: 1 }, { leads: 0, converted: 0 }]).map((r) => r.conversion)).toEqual([0.25, 0]);
    expect(enrich("seller_performance", [{ won_count: 3, lost_count: 1 }, { won_count: 0, lost_count: 0 }]).map((r) => r.win_rate)).toEqual([0.75, null]);
  });
  it("formats cells", () => {
    const people = new Map([["u1", "Asha"]]);
    expect(formatCell("money", 1250000, people)).toContain("12,50,000");
    expect(formatCell("pct", 0.256, people)).toBe("26%");
    expect(formatCell("person", "u1", people)).toBe("Asha");
    expect(formatCell("person", null, people)).toBe("—");
    expect(formatCell("days", 4.5, people)).toBe("4.5 d");
  });
});
