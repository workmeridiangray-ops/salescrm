import { afterEach, describe, expect, it } from "vitest";
import { cronAuthorized } from "./cron";

const req = (auth?: string) => new Request("https://x.test", { headers: auth ? { authorization: auth } : {} });
afterEach(() => { delete process.env.CRON_SECRET; });
describe("cronAuthorized", () => {
  it("accepts only the exact secret", () => {
    process.env.CRON_SECRET = "a-long-enough-secret-value";
    expect(cronAuthorized(req("Bearer a-long-enough-secret-value"))).toBe(true);
    expect(cronAuthorized(req("Bearer a-long-enough-secret-valuX"))).toBe(false);
    expect(cronAuthorized(req("Bearer short"))).toBe(false);
    expect(cronAuthorized(req())).toBe(false);
  });
  it("refuses everything when no (or a weak) secret is configured", () => {
    expect(cronAuthorized(req("Bearer "))).toBe(false);
    process.env.CRON_SECRET = "short";
    expect(cronAuthorized(req("Bearer short"))).toBe(false);
  });
});
