import { describe, expect, it } from "vitest";
import { NEEDS_APPROVAL, calcQuote, currentPeriod, effectiveStatus, isPeriod, shiftPeriod } from "./quote";

describe("calcQuote", () => {
  it("no discount, 18% GST", () => {
    expect(calcQuote([{ qty: 2, unitPrice: 1000, taxRate: 18 }], 0)).toEqual({ subtotal: 2000, discountTotal: 0, taxTotal: 360, total: 2360 });
  });
  it("discount applies before tax, per line", () => {
    expect(calcQuote([{ qty: 1, unitPrice: 1000, taxRate: 18 }], 10)).toEqual({ subtotal: 1000, discountTotal: 100, taxTotal: 162, total: 1062 });
  });
  it("rounds each line to paise (half away from zero)", () => {
    // unit prices have 2 decimals; quantities 3. 0.5 x 0.05 = 0.025 -> 0.03
    expect(calcQuote([{ qty: 0.5, unitPrice: 0.05, taxRate: 0 }], 0).subtotal).toBe(0.03);
    expect(calcQuote([{ qty: 3.333, unitPrice: 10, taxRate: 0 }], 0).subtotal).toBe(33.33);
    expect(calcQuote([{ qty: 1, unitPrice: 0.05, taxRate: 0 }], 50).discountTotal).toBe(0.03); // 0.025 -> 0.03
  });
  it("mixed tax rates and fractional quantities", () => {
    const t = calcQuote([{ qty: 1.5, unitPrice: 999.99, taxRate: 12 }, { qty: 4, unitPrice: 250, taxRate: 5 }], 7.5);
    expect(t.total).toBeCloseTo(t.subtotal - t.discountTotal + t.taxTotal, 2);
  });
  it("empty quote is all zeros", () => expect(calcQuote([], 20)).toEqual({ subtotal: 0, discountTotal: 0, taxTotal: 0, total: 0 }));
});

describe("approval and status", () => {
  it("only discounts strictly above the threshold need approval", () => {
    expect(NEEDS_APPROVAL(10, 10)).toBe(false);
    expect(NEEDS_APPROVAL(10.01, 10)).toBe(true);
  });
  it("a sent quote past its date reads as expired", () => {
    expect(effectiveStatus("sent", "2026-01-01", "2026-01-02")).toBe("expired");
    expect(effectiveStatus("sent", "2026-01-02", "2026-01-02")).toBe("sent");
    expect(effectiveStatus("accepted", "2020-01-01", "2026-01-02")).toBe("accepted");
  });
});

describe("periods", () => {
  it("validates and shifts across year ends", () => {
    expect(isPeriod("2026-12")).toBe(true);
    expect(isPeriod("2026-13")).toBe(false);
    expect(shiftPeriod("2026-12", 1)).toBe("2027-01");
    expect(shiftPeriod("2026-01", -1)).toBe("2025-12");
    expect(currentPeriod(new Date(2026, 10, 11))).toBe("2026-11");
  });
});
