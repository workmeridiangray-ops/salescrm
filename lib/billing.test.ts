import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseEvent, verifySignature } from "./billing";

const sign = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("hex");

describe("verifySignature", () => {
  const body = '{"event":"subscription.activated"}';
  it("accepts the right signature", () => expect(verifySignature(body, sign(body, "s3cret"), "s3cret")).toBe(true));
  it("rejects a wrong secret, tampered body, missing header or empty secret", () => {
    expect(verifySignature(body, sign(body, "other"), "s3cret")).toBe(false);
    expect(verifySignature(body + " ", sign(body, "s3cret"), "s3cret")).toBe(false);
    expect(verifySignature(body, null, "s3cret")).toBe(false);
    expect(verifySignature(body, sign(body, ""), "")).toBe(false);
    expect(verifySignature(body, "short", "s3cret")).toBe(false);
  });
});

describe("parseEvent", () => {
  const tid = "11111111-2222-4333-8444-555555555555";
  const ev = (event: string, notes: object = { tenant_id: tid, plan_key: "growth", interval: "yearly" }) =>
    ({ event, payload: { subscription: { entity: { id: "sub_9", current_end: 1_800_000_000, notes } } } });
  it("extracts the fields we use", () => {
    expect(parseEvent("evt_1", ev("subscription.activated"))).toEqual({
      eventId: "evt_1", type: "subscription.activated", tenantId: tid, planKey: "growth", interval: "yearly",
      subscriptionId: "sub_9", periodEnd: new Date(1_800_000_000_000).toISOString(),
    });
  });
  it("ignores unhandled events and missing ids", () => {
    expect(parseEvent("evt_1", ev("payment.captured"))).toBeNull();
    expect(parseEvent(null, ev("subscription.activated"))).toBeNull();
    expect(parseEvent("evt_1", {})).toBeNull();
  });
  it("drops a tenant id that is not a UUID", () => {
    expect(parseEvent("e", ev("subscription.charged", { tenant_id: "'; drop table x;--" }))!.tenantId).toBeNull();
  });
});
