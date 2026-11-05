import { beforeAll, describe, expect, it } from "vitest";
import { as, EMAIL, failure, ids, seed, switchTo, U, type Q } from "./helpers";

beforeAll(seed);

const stage = async (q: Q, tenant: string, kind: string, pos = 0) =>
  (await q("select id, pipeline_id from stages where tenant_id = $1 and kind = $2 order by position limit 1 offset $3", [tenant, kind, pos]))[0]!;
const mkOpp = async (q: Q, tenant: string, name = "Deal", amount = 1000) => {
  const s = await stage(q, tenant, "open");
  return (await q("insert into opportunities (tenant_id, name, pipeline_id, stage_id, amount) values ($1, $2, $3, $4, $5) returning id", [tenant, name, s.pipeline_id, s.id, amount]))[0]!.id as string;
};

describe("ownership visibility", () => {
  it("staff see only their own records; manager and owner see all", async () => {
    await as("staffA", async (q) => {
      await q("insert into accounts (tenant_id, name) values ($1, 'Staff Co')", [ids.acme]);
    });
    await as("ownerA", async (q) => {
      await q("insert into accounts (tenant_id, name, owner_id) values ($1, 'Owner Co', $2)", [ids.acme, U.ownerA]);
      await q("insert into accounts (tenant_id, name, owner_id) values ($1, 'Staff Co', $2)", [ids.acme, U.staffA]);
      expect(await q("select 1 from accounts")).toHaveLength(2);
      await switchTo(q, "staffA");
      expect((await q("select name from accounts")).map((r) => r.name)).toEqual(["Staff Co"]);
      await switchTo(q, "managerA");
      expect(await q("select 1 from accounts")).toHaveLength(2);
    });
  });

  it("staff cannot create records for someone else or edit others' records", async () => {
    await as("ownerA", async (q) => {
      const o = await q("insert into accounts (tenant_id, name, owner_id) values ($1, 'Owned by owner', $2) returning id", [ids.acme, U.ownerA]);
      await switchTo(q, "staffA");
      expect(await failure(q("insert into accounts (tenant_id, name, owner_id) values ($1, 'x', $2)", [ids.acme, U.ownerA]))).toMatch(/row-level security/);
      expect(await q("update accounts set name = 'Hijack' where id = $1 returning id", [o[0]!.id])).toHaveLength(0);
    });
  });

  it("staff cannot hand a record to another person; a manager can", async () => {
    await as("staffA", async (q) => {
      const a = await q("insert into accounts (tenant_id, name) values ($1, 'Mine') returning id", [ids.acme]);
      expect(await failure(q("update accounts set owner_id = $1 where id = $2", [U.ownerA, a[0]!.id]))).toMatch(/row-level security/);
      await switchTo(q, "managerA");
      await q("update accounts set owner_id = $1 where id = $2", [U.managerA, a[0]!.id]);
    });
  });

  it("an owner must be an active member of the same workspace", async () => {
    await as("ownerA", async (q) => {
      expect(await failure(q("insert into accounts (tenant_id, name, owner_id) values ($1, 'x', $2)", [ids.acme, U.ownerB]))).toMatch(/owner_not_member/);
    });
  });
});

describe("cross-tenant guarantees", () => {
  it("another workspace's records are invisible and unreachable", async () => {
    await as("ownerB", async (q) => { await q("insert into accounts (tenant_id, name) values ($1, 'Globex Secret')", [ids.globex]); });
    await as("ownerB", async (q) => {
      const g = (await q("insert into accounts (tenant_id, name) values ($1, 'Globex Secret 2') returning id", [ids.globex]))[0]!.id;
      await switchTo(q, "ownerA");
      for (const t of ["accounts", "contacts", "leads", "opportunities", "activities", "opportunity_history"]) {
        expect(await q(`select 1 from ${t} where tenant_id = $1`, [ids.globex]), t).toHaveLength(0);
      }
      expect(await q("select 1 from accounts where id = $1", [g])).toHaveLength(0);
      expect(await q("update accounts set name = 'x' where id = $1 returning id", [g])).toHaveLength(0);
      expect(await failure(q("insert into accounts (tenant_id, name) values ($1, 'Injected')", [ids.globex]))).toMatch(/row-level security|owner_not_member/);
    });
  });

  it("links across tenants are impossible even for the database owner", async () => {
    await as("ownerB", async (q) => {
      const g = (await q("insert into accounts (tenant_id, name) values ($1, 'G') returning id", [ids.globex]))[0]!.id;
      await switchTo(q, "owner");
      expect(await failure(q("insert into contacts (tenant_id, account_id, full_name, owner_id) values ($1, $2, 'X', null)", [ids.acme, g]))).toMatch(/foreign key/);
      const s = await stage(q, ids.globex, "open");
      expect(await failure(q("insert into opportunities (tenant_id, name, pipeline_id, stage_id, owner_id) values ($1, 'X', $2, $3, null)", [ids.acme, s.pipeline_id, s.id]))).toMatch(/foreign key/);
    });
  });

  it("tenant_id cannot be changed after creation", async () => {
    await as("ownerA", async (q) => {
      const a = (await q("insert into accounts (tenant_id, name) values ($1, 'Mover') returning id", [ids.acme]))[0]!.id;
      expect(await failure(q("update accounts set tenant_id = $1 where id = $2", [ids.globex, a]))).toMatch(/row-level security|immutable/);
    });
  });

  it("nothing can be deleted by clients", async () => {
    await as("ownerA", async (q) => {
      for (const t of ["accounts", "contacts", "leads", "opportunities", "activities", "stages", "pipelines"]) {
        expect(await failure(q(`delete from ${t}`)), t).toMatch(/permission denied/);
      }
    });
  });
});

describe("duplicates", () => {
  it("rejects duplicate account names and contact emails within a workspace, allows them across workspaces", async () => {
    await as("ownerA", async (q) => {
      await q("insert into accounts (tenant_id, name) values ($1, 'Dup Co')", [ids.acme]);
      expect(await failure(q("insert into accounts (tenant_id, name) values ($1, 'dup co')", [ids.acme]))).toMatch(/accounts_name_unique/);
      await q("insert into contacts (tenant_id, full_name, email) values ($1, 'A', 'a@dup.test')", [ids.acme]);
      expect(await failure(q("insert into contacts (tenant_id, full_name, email) values ($1, 'B', 'a@dup.test')", [ids.acme]))).toMatch(/contacts_email_unique/);
    });
    await as("ownerB", async (q) => {
      await q("insert into accounts (tenant_id, name) values ($1, 'Dup Co')", [ids.globex]);
    });
  });
});

describe("opportunities", () => {
  it("history is written automatically; stage, amount and owner changes are all recorded", async () => {
    await as("ownerA", async (q) => {
      const id = await mkOpp(q, ids.acme);
      const next = await stage(q, ids.acme, "open", 1);
      await q("update opportunities set stage_id = $1, amount = 2500 where id = $2", [next.id, id]);
      await q("update opportunities set owner_id = $1 where id = $2", [U.managerA, id]);
      const ev = (await q("select event from opportunity_history where opportunity_id = $1 order by id", [id])).map((r) => r.event);
      expect(ev).toEqual(["created", "stage_changed", "amount_changed", "owner_changed"]);
      expect(await failure(q("update opportunity_history set event = 'x'"))).toMatch(/permission denied/);
    });
  });

  it("a lost deal needs a reason; won/lost follow the stage; reopening keeps history", async () => {
    await as("ownerA", async (q) => {
      const id = await mkOpp(q, ids.acme);
      const lost = await stage(q, ids.acme, "lost");
      const won = await stage(q, ids.acme, "won");
      const open = await stage(q, ids.acme, "open");
      expect(await failure(q("update opportunities set stage_id = $1 where id = $2", [lost.id, id]))).toMatch(/loss_reason_required/);
      await q("update opportunities set stage_id = $1, loss_reason = 'Price' where id = $2", [lost.id, id]);
      expect((await q("select status from opportunities where id = $1", [id]))[0]!.status).toBe("lost");
      await q("update opportunities set stage_id = $1 where id = $2", [open.id, id]);
      const o = (await q("select status, loss_reason from opportunities where id = $1", [id]))[0]!;
      expect(o).toMatchObject({ status: "open", loss_reason: null });
      await q("update opportunities set stage_id = $1 where id = $2", [won.id, id]);
      const ev = (await q("select event from opportunity_history where opportunity_id = $1 order by id", [id])).map((r) => r.event);
      expect(ev).toEqual(["created", "stage_changed", "reopened", "stage_changed"]);
    });
  });

  it("a stage from a different pipeline is refused", async () => {
    await as("ownerA", async (q) => {
      await q("insert into pipelines (tenant_id, name) values ($1, 'Renewals')", [ids.acme]);
      const p2 = (await q("select id from pipelines where name = 'Renewals' and tenant_id = $1", [ids.acme]))[0]!.id;
      await q("insert into stages (tenant_id, pipeline_id, name, position, probability) values ($1, $2, 'Renewal due', 0, 50)", [ids.acme, p2]);
      const foreign = (await q("select id from stages where pipeline_id = $1", [p2]))[0]!.id;
      const id = await mkOpp(q, ids.acme);
      expect(await failure(q("update opportunities set stage_id = $1 where id = $2", [foreign, id]))).toMatch(/foreign key/);
    });
  });

  it("only pipeline.configure holders can change stages", async () => {
    await as("staffA", async (q) => {
      expect(await failure(q("insert into stages (tenant_id, pipeline_id, name, position, probability) select tenant_id, pipeline_id, 'Sneaky', 9, 5 from stages where tenant_id = $1 limit 1", [ids.acme]))).toMatch(/row-level security/);
    });
    await as("managerA", async (q) => {
      await q("insert into stages (tenant_id, pipeline_id, name, position, probability) select tenant_id, pipeline_id, 'Discovery', 9, 5 from stages where tenant_id = $1 limit 1", [ids.acme]);
    });
  });
});

describe("leads", () => {
  const capture = (q: Q, slug: string, name: string, email: string | null, company: string | null = null) =>
    q("select capture_lead($1, $2, $3, $4, null, 'hello')", [slug, name, email, company]);

  it("anonymous web capture works, scores explainably and assigns an owner", async () => {
    await as(null, async (q) => { await capture(q, "acme", "Web Person", "web@bigco.test", "BigCo"); });
    // anon cannot read what it created; verify as the owner
    await as("ownerA", async (q) => {
      await q("select capture_lead('acme', 'Web Person', 'web@bigco.test', 'BigCo', null, 'hello')");
      const l = (await q("select score, score_reasons, owner_id, source from leads where email = 'web@bigco.test'"))[0]!;
      expect(l.score).toBe(60); // business domain 30 + company 20 + message 10
      expect(l.score_reasons.map((r: any) => r.reason)).toContain("Business email domain");
      expect(l.source).toBe("web");
      expect(l.owner_id).not.toBeNull();
    });
  });

  it("repeat submissions do not duplicate; unknown workspaces reveal nothing; bad input is rejected", async () => {
    await as("ownerA", async (q) => {
      await capture(q, "acme", "Twice", "twice@x.test");
      await capture(q, "acme", "Twice", "twice@x.test");
      expect(await q("select 1 from leads where email = 'twice@x.test'")).toHaveLength(1);
      await capture(q, "no-such-workspace", "Ghost", "g@x.test");
      expect(await failure(capture(q, "acme", "   ", "x@x.test"))).toMatch(/invalid_lead/);
    });
  });

  it("round robin spreads leads between writers", async () => {
    await as("ownerA", async (q) => {
      for (let i = 0; i < 6; i++) await capture(q, "acme", `Lead ${i}`, `rr${i}@x.test`);
      const rows = await q("select owner_id, count(*)::int n from leads where email like 'rr%' group by owner_id");
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(Math.max(...rows.map((r) => r.n)) - Math.min(...rows.map((r) => r.n))).toBeLessThanOrEqual(1);
    });
  });

  it("conversion links existing records instead of duplicating them", async () => {
    await as("ownerA", async (q) => {
      const acct = (await q("insert into accounts (tenant_id, name) values ($1, 'Linked Co') returning id", [ids.acme]))[0]!.id;
      const ct = (await q("insert into contacts (tenant_id, account_id, full_name, email) values ($1, $2, 'Known', 'known@linked.test') returning id", [ids.acme, acct]))[0]!.id;
      const lead = (await q("insert into leads (tenant_id, name, email, company, owner_id) values ($1, 'Known', 'known@linked.test', 'linked co', $2) returning id", [ids.acme, U.ownerA]))[0]!.id;
      const oid = (await q("select convert_lead($1, 5000) id", [lead]))[0]!.id;
      expect(await q("select 1 from accounts where lower(name) = 'linked co'")).toHaveLength(1);
      expect(await q("select 1 from contacts where email = 'known@linked.test'")).toHaveLength(1);
      const o = (await q("select contact_id, account_id, amount from opportunities where id = $1", [oid]))[0]!;
      expect(o).toMatchObject({ contact_id: ct, account_id: acct, amount: "5000.00" });
      expect(await failure(q("select convert_lead($1)", [lead]))).toMatch(/lead_already_converted/);
    });
  });

  it("disqualifying needs a reason and blocks conversion", async () => {
    await as("ownerA", async (q) => {
      const lead = (await q("insert into leads (tenant_id, name, owner_id) values ($1, 'Nope', $2) returning id", [ids.acme, U.ownerA]))[0]!.id;
      expect(await failure(q("update leads set status = 'disqualified' where id = $1", [lead]))).toMatch(/check/);
      await q("update leads set status = 'disqualified', disqualify_reason = 'No budget' where id = $1", [lead]);
      expect(await failure(q("select convert_lead($1)", [lead]))).toMatch(/lead_disqualified/);
    });
  });

  it("a staff member cannot convert someone else's lead", async () => {
    await as("ownerA", async (q) => {
      const lead = (await q("insert into leads (tenant_id, name, owner_id) values ($1, 'Private', $2) returning id", [ids.acme, U.ownerA]))[0]!.id;
      await switchTo(q, "staffA");
      expect(await failure(q("select convert_lead($1)", [lead]))).toMatch(/lead_not_found/);
    });
  });

  it("unassigned leads are visible to managers only", async () => {
    await as("ownerA", async (q) => {
      await q("insert into leads (tenant_id, name, owner_id) values ($1, 'Orphan', null)", [ids.acme]);
      await switchTo(q, "staffA");
      expect(await q("select 1 from leads where name = 'Orphan'")).toHaveLength(0);
      await switchTo(q, "managerA");
      expect(await q("select 1 from leads where name = 'Orphan'")).toHaveLength(1);
    });
  });
});

describe("activities", () => {
  it("a task can only link records in its own workspace", async () => {
    await as("ownerB", async (q) => {
      const g = (await q("insert into accounts (tenant_id, name) values ($1, 'GA') returning id", [ids.globex]))[0]!.id;
      await switchTo(q, "ownerA");
      expect(await failure(q("insert into activities (tenant_id, subject, account_id) values ($1, 'call', $2)", [ids.acme, g]))).toMatch(/foreign key/);
    });
  });
});
void EMAIL;
