import { describe, expect, it } from "vitest";
import { isPrivateIp, isSafeWebhookUrl, signPayload } from "./webhooks";

describe("isPrivateIp", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "999.1.1.1", "1.2.3"])("%s is refused", (ip) => expect(isPrivateIp(ip)).toBe(true));
  it.each(["8.8.8.8", "172.32.0.1", "100.63.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])("%s is public", (ip) => expect(isPrivateIp(ip)).toBe(false));
});
describe("isSafeWebhookUrl", () => {
  it("accepts ordinary https endpoints", () => {
    expect(isSafeWebhookUrl("https://hooks.example.com/in")).toBe(true);
    expect(isSafeWebhookUrl("https://hooks.example.com:443/in?x=1")).toBe(true);
    expect(isSafeWebhookUrl("https://8.8.8.8/in")).toBe(true);
  });
  it.each([
    "http://hooks.example.com", "https://localhost/x", "https://localhost./x", "https://intranet/x", "https://svc.internal/x", "https://printer.local/x",
    "https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data", "https://[::1]/x", "https://user:pw@hooks.example.com/x",
    "https://hooks.example.com:8443/x", "ftp://x.example.com", "not a url", "https://2130706433/",
  ])("%s is refused", (u) => expect(isSafeWebhookUrl(u)).toBe(false));
});
describe("signPayload", () => {
  it("is deterministic and depends on secret, timestamp and body", () => {
    const s = signPayload("k", 1700000000, "{}");
    expect(s).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signPayload("k", 1700000000, "{}")).toBe(s);
    expect(signPayload("k2", 1700000000, "{}")).not.toBe(s);
    expect(signPayload("k", 1700000001, "{}")).not.toBe(s);
    expect(signPayload("k", 1700000000, "{ }")).not.toBe(s);
  });
});
