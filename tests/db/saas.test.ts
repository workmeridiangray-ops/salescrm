import { beforeAll, describe, expect, it } from "vitest";
import { as, asOwner, failure, ids, seed, switchTo, U, EMAIL } from "./helpers";

beforeAll(seed);
const apply = (q: any, id: string, type: string, tenant = ids.acme, plan = "scale") =>
  q("select apply_billing_event($1, $2, $3, $4, 'monthly', 'sub_1', now() + interval '30 days') r", [id, type, tenant, plan]);

describe("plans and trials", () => {
  it("anyone, even signed out, can read active plans; nobody can write them", async () => {
    await as(null, async (q) => {
      expect((await q("select key from plans order by sort")).map((r) => r.key)).toEqual(["starter", "growth", "scale"]);
      expect(await failure(q("update plans set monthly_inr = 1"))).toMatch(/permission denied/);
    });
  });

  it("a new workspace starts a 14-day trial; members see only their own subscription", async () => {
    await as("staffA", async (q) => {
      const rows = await q("select tenant_id, plan_key, status from subscriptions");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tenant_id: ids.acme, status: "trialing" });
      expect(await failure(q("update subscriptions set plan_key = 'scale'"))).toMatch(/permission denied/);
    });
  });
});

describe("seat limits", () => {
  it("inviting beyond the plan's user limit is refused", async () => {
    await asOwner(async (q) => {
      await q("update subscriptions set plan_key = 'starter' where tenant_id = $1", [ids.acme]);
      await switchTo(q, "ownerA");
      expect(await failure(q("select invite_member($1, 'extra@x.test', $2)", [ids.acme, ids.roles.acme!.staff]))).toBe("plan_limit_users");
    });
  });
  it("open invitations hold a seat", async () => {
    await asOwner(async (q) => {
      await q("update subscriptions set plan_key = 'starter' where tenant_id = $1", [ids.acme]);
      await q("delete from memberships where tenant_id = $1 and user_id = $2", [ids.acme, U.staffA]); // 2 members, limit 3
      await switchTo(q, "ownerA");
      await q("select invite_member($1, 'one@x.test', $2)", [ids.acme, ids.roles.acme!.staff]);
      expect(await failure(q("select invite_member($1, 'two@x.test', $2)", [ids.acme, ids.roles.acme!.staff]))).toBe("plan_limit_users");
    });
  });
});

describe("payment provider events", () => {
  it("only the service role can apply them", async () => {
    await as("ownerA", async (q) => {
      expect(await failure(apply(q, "evt_x", "subscription.activated"))).toMatch(/permission denied/);
    });
    await as(null, async (q) => {
      expect(await failure(apply(q, "evt_x", "subscription.activated"))).toMatch(/permission denied/);
    });
  });

  it("activation, failure, cancellation; replays are ignored", async () => {
    await asOwner(async (q) => {
      await q("set local role service_role");
      expect((await apply(q, "evt_1", "subscription.activated"))[0]!.r).toBe(true);
      expect((await apply(q, "evt_1", "subscription.activated"))[0]!.r).toBe(false);
      await q("reset role");
      let s = (await q("select status, plan_key from subscriptions where tenant_id = $1", [ids.acme]))[0]!;
      expect(s).toMatchObject({ status: "active", plan_key: "scale" });
      await q("set local role service_role");
      await apply(q, "evt_2", "subscription.halted");
      await q("reset role");
      s = (await q("select status, grace_until from subscriptions where tenant_id = $1", [ids.acme]))[0]!;
      expect(s.status).toBe("past_due");
      expect(s.grace_until).not.toBeNull();
      await q("set local role service_role");
      await apply(q, "evt_3", "subscription.cancelled");
      await q("reset role");
      expect((await q("select status from subscriptions where tenant_id = $1", [ids.acme]))[0]!.status).toBe("canceled");
    });
  });

  it("events for unknown workspaces or plans do no harm", async () => {
    await asOwner(async (q) => {
      await q("set local role service_role");
      await apply(q, "evt_u", "subscription.activated", "99999999-0000-4000-8000-000000000000");
      await apply(q, "evt_p", "subscription.activated", ids.acme, "no_such_plan");
      await q("reset role");
      expect((await q("select plan_key from subscriptions where tenant_id = $1", [ids.acme]))[0]!.plan_key).not.toBe("no_such_plan");
    });
  });
});

describe("platform staff", () => {
  it("ordinary users, even owners, are refused", async () => {
    await as("ownerA", async (q) => {
      expect(await failure(q("select * from platform_overview()"))).toBe("forbidden");
      expect(await failure(q("select platform_set_tenant_status($1, 'suspended', 'x')", [ids.globex]))).toBe("forbidden");
      expect(await failure(q("select * from platform_demo_requests()"))).toBe("forbidden");
      expect(await failure(q("select * from platform_staff"))).toMatch(/permission denied/);
    });
  });

  it("support can suspend with a reason (audited); billing cannot; suspension blocks members", async () => {
    await asOwner(async (q) => {
      await q("insert into platform_staff (user_id, role) values ($1, 'support'), ($2, 'billing')", [U.outsider, U.invitee]);
      await switchTo(q, "outsider");
      expect(await q("select * from platform_overview()")).toHaveLength(2);
      expect(await failure(q("select platform_set_tenant_status($1, 'suspended', '')", [ids.globex]))).toBe("reason_required");
      await q("select platform_set_tenant_status($1, 'suspended', 'Chargeback dispute')", [ids.globex]);
      await switchTo(q, "invitee");
      expect(await failure(q("select platform_set_tenant_status($1, 'active', 'x')", [ids.globex]))).toBe("forbidden");
      await switchTo(q, "ownerB");
      expect(await failure(q("select update_workspace($1, 'Still here')", [ids.globex]))).toBe("forbidden");
      await switchTo(q, "owner");
      const a = await q("select actor_id, detail from audit_log where tenant_id = $1 and action = 'platform.status_changed'", [ids.globex]);
      expect(a[0]).toMatchObject({ actor_id: U.outsider });
      expect(a[0]!.detail.reason).toBe("Chargeback dispute");
    });
  });

  it("expiry suspends lapsed trials and grace periods only", async () => {
    await asOwner(async (q) => {
      await q("insert into platform_staff (user_id, role) values ($1, 'billing')", [U.invitee]);
      await q("update subscriptions set trial_ends_at = now() - interval '1 day' where tenant_id = $1", [ids.acme]);
      await switchTo(q, "invitee");
      expect((await q("select platform_expire_subscriptions() n"))[0]!.n).toBe(1);
      await switchTo(q, "owner");
      const r = await q("select slug, status from tenants order by slug");
      expect(r).toEqual([{ slug: "acme", status: "suspended" }, { slug: "globex", status: "trial" }]);
    });
  });
});

describe("demo requests", () => {
  it("anonymous visitors can submit but never read; junk is rejected", async () => {
    await as(null, async (q) => {
      await q("select submit_demo_request('Pat', 'pat@firm.test', 'Firm', 'Hi')");
      expect(await failure(q("select * from demo_requests"))).toMatch(/permission denied/);
      expect(await failure(q("select submit_demo_request('', 'bad', null, null)"))).toMatch(/invalid_request/);
    });
  });
});
void EMAIL;
