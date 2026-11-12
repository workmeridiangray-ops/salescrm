import { beforeAll, describe, expect, it } from "vitest";
import { as, failure, ids, seed, switchTo, U, type Q } from "./helpers";

beforeAll(seed);
const mk = async (q: Q, events = ["lead.created", "opportunity.won", "quote.accepted"], tenant = ids.acme, url = "https://hooks.example.com/in") =>
  (await q("select create_webhook($1, $2, $3) r", [tenant, url, events]))[0]!.r as { id: string; secret: string };
const deliveries = (q: Q) => q("select id, event, status, attempts, tenant_id from webhook_deliveries order by id");
const claim = async (q: Q, n = 10) => {
  await switchTo(q, "owner"); await q("set local role service_role");
  const r = await q("select * from webhook_claim_batch($1)", [n]);
  await q("reset role");
  return r;
};

describe("endpoints", () => {
  it("only HTTPS URLs; the secret is returned once and never readable by clients", async () => {
    await as("ownerA", async (q) => {
      expect(await failure(q("select create_webhook($1, 'http://plain.example.com', array['lead.created'])", [ids.acme]))).toMatch(/check/);
      expect(await failure(q("select create_webhook($1, 'https://user:pw@evil.example.com/x', array['lead.created'])", [ids.acme]))).toMatch(/check/);
      expect(await failure(q("select create_webhook($1, 'https://ok.example.com', array['everything'])", [ids.acme]))).toMatch(/check/);
      const w = await mk(q);
      expect(w.secret).toMatch(/^whsec_/);
      expect(await failure(q("select secret from webhook_endpoints"))).toMatch(/permission denied/);
      expect(await q("select id, url from webhook_endpoints")).toHaveLength(1);
    });
  });
  it("managers cannot manage; other workspaces cannot see them", async () => {
    await as("managerA", async (q) => {
      expect(await failure(q("select create_webhook($1, 'https://x.example.com', array['lead.created'])", [ids.acme]))).toBe("forbidden");
    });
    await as("ownerA", async (q) => {
      await mk(q);
      await switchTo(q, "ownerB");
      expect(await q("select 1 from webhook_endpoints")).toHaveLength(0);
      expect(await failure(q("select create_webhook($1, 'https://x.example.com', array['lead.created'])", [ids.acme]))).toBe("forbidden");
    });
  });
  it("limits a workspace to 10 endpoints", async () => {
    await as("ownerA", async (q) => {
      for (let i = 0; i < 10; i++) await mk(q, ["lead.created"], ids.acme, `https://h${i}.example.com/x`);
      expect(await failure(mk(q))).toBe("webhook_limit");
    });
  });
});

describe("events", () => {
  it("queue only for subscribed events, active endpoints and the same workspace", async () => {
    await as("ownerA", async (q) => {
      const a = await mk(q, ["lead.created"]);
      await mk(q, ["quote.accepted"]);
      const off = await mk(q, ["lead.created"], ids.acme, "https://off.example.com/x");
      await q("select set_webhook_active($1, $2, false)", [ids.acme, off.id]);
      await switchTo(q, "ownerB");
      await mk(q, ["lead.created"], ids.globex);
      await switchTo(q, "ownerA");
      await q("insert into leads (tenant_id, name, owner_id) values ($1, 'Evented', $2)", [ids.acme, U.ownerA]);
      const d = await deliveries(q);
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ event: "lead.created", status: "pending", tenant_id: ids.acme });
      const p = (await q("select payload from webhook_deliveries"))[0]!.payload;
      expect(p).toMatchObject({ event: "lead.created", workspace: "acme", data: { name: "Evented" } });
      void a;
    });
  });
  it("opportunity.won fires once, on the transition", async () => {
    await as("ownerA", async (q) => {
      await mk(q, ["opportunity.won"]);
      const s = (await q("select id, pipeline_id from stages where tenant_id = $1 and kind = 'open' order by position limit 1", [ids.acme]))[0]!;
      const w = (await q("select id from stages where tenant_id = $1 and kind = 'won'", [ids.acme]))[0]!.id;
      const o = (await q("insert into opportunities (tenant_id, name, pipeline_id, stage_id, amount) values ($1, 'W', $2, $3, 10) returning id", [ids.acme, s.pipeline_id, s.id]))[0]!.id;
      expect(await deliveries(q)).toHaveLength(0);
      await q("update opportunities set stage_id = $1 where id = $2", [w, o]);
      await q("update opportunities set next_action = 'x' where id = $1", [o]);
      expect(await deliveries(q)).toHaveLength(1);
    });
  });
});

describe("dispatch queue", () => {
  it("only the service role can claim or report", async () => {
    await as("ownerA", async (q) => {
      expect(await failure(q("select * from webhook_claim_batch(5)"))).toMatch(/permission denied/);
      expect(await failure(q("select webhook_report(1, true, 200, null)"))).toMatch(/permission denied/);
    });
  });
  it("claiming leases a delivery so a second worker gets nothing; success marks it delivered", async () => {
    await as("ownerA", async (q) => {
      await mk(q, ["lead.created"]);
      await q("insert into leads (tenant_id, name, owner_id) values ($1, 'L', $2)", [ids.acme, U.ownerA]);
      const first = await claim(q);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ attempts: 1, event: "lead.created" });
      expect(first[0]!.secret).toMatch(/^whsec_/);
      expect(await claim(q)).toHaveLength(0);
      await switchTo(q, "owner"); await q("set local role service_role");
      await q("select webhook_report($1, true, 200, null)", [first[0]!.id]);
      await q("reset role");
      expect((await deliveries(q))[0]!.status).toBe("delivered");
    });
  });
  it("failures back off, then go dead after 6 attempts; dead ones can be retried by an owner", async () => {
    await as("ownerA", async (q) => {
      await mk(q, ["lead.created"]);
      await q("insert into leads (tenant_id, name, owner_id) values ($1, 'L', $2)", [ids.acme, U.ownerA]);
      for (let attempt = 1; attempt <= 6; attempt++) {
        await switchTo(q, "owner");
        await q("update webhook_deliveries set next_attempt_at = now() - interval '1 second'");
        const c = await claim(q);
        expect(c).toHaveLength(1);
        expect(c[0]!.attempts).toBe(attempt);
        await switchTo(q, "owner"); await q("set local role service_role");
        await q("select webhook_report($1, false, 500, 'boom')", [c[0]!.id]);
        await q("reset role");
        const d = (await q("select status, next_attempt_at > now() as later from webhook_deliveries"))[0]!;
        expect(d.status).toBe(attempt < 6 ? "pending" : "dead");
        if (attempt < 6) expect(d.later).toBe(true);
      }
      await switchTo(q, "ownerA");
      const id = (await q("select id from webhook_deliveries"))[0]!.id;
      await q("select retry_delivery($1, $2)", [ids.acme, id]);
      expect((await q("select status, attempts from webhook_deliveries"))[0]).toEqual({ status: "pending", attempts: 0 });
      expect(await failure(q("select retry_delivery($1, $2)", [ids.acme, id]))).toBe("delivery_not_retryable");
    });
  });
  it("disabled endpoints and suspended workspaces are not delivered to", async () => {
    await as("ownerA", async (q) => {
      const w = await mk(q, ["lead.created"]);
      await q("insert into leads (tenant_id, name, owner_id) values ($1, 'L', $2)", [ids.acme, U.ownerA]);
      await q("select set_webhook_active($1, $2, false)", [ids.acme, w.id]);
      expect(await claim(q)).toHaveLength(0);
      await switchTo(q, "ownerA");
      await q("select set_webhook_active($1, $2, true)", [ids.acme, w.id]);
      await switchTo(q, "owner");
      await q("update tenants set status = 'suspended' where id = $1", [ids.acme]);
      expect(await claim(q)).toHaveLength(0);
    });
  });
});
