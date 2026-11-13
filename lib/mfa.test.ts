import { describe, expect, it } from "vitest";
import { mfaRedirect } from "./mfa";

describe("mfaRedirect", () => {
  it("lets through people without an enrolled factor or already at aal2", () => {
    expect(mfaRedirect("aal1", "aal1", "/w/acme")).toBeNull();
    expect(mfaRedirect("aal2", "aal2", "/w/acme")).toBeNull();
    expect(mfaRedirect(null, null, "/w/acme")).toBeNull();
  });
  it("sends enrolled but unverified sessions to /mfa, remembering where they were going", () => {
    expect(mfaRedirect("aal1", "aal2", "/w/acme/members", "?x=1")).toBe("/mfa?next=%2Fw%2Facme%2Fmembers%3Fx%3D1");
  });
  it("never loops and never blocks public or machine endpoints", () => {
    for (const p of ["/mfa", "/login", "/api/v1/accounts", "/api/webhooks/dispatch", "/capture/acme", "/quote/abc", "/u/t", "/book/x-y", "/m/t"]) expect(mfaRedirect("aal1", "aal2", p)).toBeNull();
  });
  it("does not carry an unsafe next target", () => {
    expect(mfaRedirect("aal1", "aal2", "//evil.test")).toBe("/mfa?next=%2Fworkspaces");
  });
});
