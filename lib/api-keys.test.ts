import { describe, expect, it } from "vitest";
import { apiStatus, bearerToken } from "./api-keys";

const KEY = "sk_live_" + "a".repeat(64);
describe("bearerToken", () => {
  it("accepts a well-formed key only", () => {
    expect(bearerToken(`Bearer ${KEY}`)).toBe(KEY);
    for (const bad of [null, "", KEY, `bearer ${KEY}`, "Bearer sk_live_short", `Bearer ${KEY} extra`, `Bearer x${KEY}`, "Bearer sk_test_" + "a".repeat(64)]) expect(bearerToken(bad)).toBeNull();
  });
});
describe("apiStatus", () => {
  it("maps known database errors and hides the rest", () => {
    expect(apiStatus("unauthorized").status).toBe(401);
    expect(apiStatus("insufficient_scope").status).toBe(403);
    expect(apiStatus("rate_limited").status).toBe(429);
    expect(apiStatus("unknown_entity").status).toBe(404);
    expect(apiStatus("invalid_lead").status).toBe(422);
    expect(apiStatus('relation "x" does not exist')).toEqual({ status: 500, code: "server_error" });
  });
});
