import { describe, expect, it } from "vitest";
import { inr, likeTerm, one, pageOf } from "./util";

describe("util", () => {
  it("one() unwraps embedded relations", () => {
    expect(one([1, 2])).toBe(1);
    expect(one(5)).toBe(5);
    expect(one(null)).toBeNull();
    expect(one([])).toBeNull();
  });
  it("likeTerm neutralises wildcards and filter syntax", () => {
    expect(likeTerm(" a%b_c,d(e) ")).toBe("%a b c d e %");
  });
  it("inr formats lakh grouping", () => expect(inr(1250000)).toContain("12,50,000"));
  it("pageOf never goes below 1", () => {
    expect(pageOf(undefined)).toBe(1);
    expect(pageOf("-3")).toBe(1);
    expect(pageOf("x")).toBe(1);
    expect(pageOf("4")).toBe(4);
  });
});
