import { beforeAll, describe, expect, it } from "vitest";
import { as, ids, seed, switchTo, U, type Q } from "./helpers";

beforeAll(seed);
const R = "current_date - 30, current_date + 1";

async function deal(q: Q, owner: string, amount: number, outcome?: "won" | "lost") {
  const s = (await q("select id, pipeline_id from stages where tenant_id = $1 order by position", [ids.acme]));
  const open = s[0]!, won = s[3]!, lost = s[4]!;
  const id = (await q("insert into opportunities (tenant_id, name, pipeline_id, stage_id, amount, owner_id) values ($1, 'D', $2, $3, $4, $5) returning id", [ids.acme, open.pipeline_id, open.id, amount, owner]))[0]!.id;
  if (outcome === "won") await q("update opportunities set stage_id = $1 where id = $2", [won.id, id]);
  if (outcome === "lost") await q("update opportunities set stage_id = $1, loss_reason = $3 where id = $2", [lost.id, id, amount > 1000 ? "Price" : "No budget"]);
  return id as string;
}

describe("reports", () => {
  it("lead sources count qualified/converted/disqualified per source", async () => {
    await as("ownerA", async (q) => {
      await q("insert into leads (tenant_id, name, source, status, owner_id, disqualify_reason) values ($1,'a','web','new',$2,null),($1,'b','web','qualified',$2,null),($1,'c','referral','disqualified',$2,'No budget')", [ids.acme, U.ownerA]);
      const r = await q(`select * from report_lead_sources($1, ${R})`, [ids.acme]);
      expect(r.find((x) => x.source === "web")).toMatchObject({ leads: 2, qualified: 1, converted: 0 });
      expect(r.find((x) => x.source === "referral")).toMatchObject({ leads: 1, disqualified: 1 });
    });
  });
  it("funnel counts opportunities that ever entered each stage", async () => {
    await as("ownerA", async (q) => {
      await deal(q, U.ownerA, 100); await deal(q, U.ownerA, 200, "won"); await deal(q, U.ownerA, 300, "lost");
      const f = await q(`select * from report_funnel($1, ${R})`, [ids.acme]);
      expect(f.map((x) => x.stage)).toEqual(["Qualification", "Proposal", "Negotiation", "Won", "Lost"]);
      expect(f.map((x) => x.entered)).toEqual([3, 0, 0, 1, 1]);
    });
  });
  it("losses group by reason, seller performance reports outcomes first", async () => {
    await as("ownerA", async (q) => {
      await deal(q, U.ownerA, 5000, "lost"); await deal(q, U.ownerA, 50, "lost"); await deal(q, U.staffA, 700, "won"); await deal(q, U.staffA, 90);
      const l = await q(`select * from report_losses($1, ${R})`, [ids.acme]);
      expect(l.map((x) => [x.reason, x.deals, +x.amount])).toEqual([["No budget", 1, 50], ["Price", 1, 5000]]);
      const p = await q(`select * from report_seller_performance($1, ${R})`, [ids.acme]);
      expect(p.find((x) => x.owner_id === U.staffA)).toMatchObject({ won_count: 1, lost_count: 0, no_next_action: 1 });
      const mine = p.find((x) => x.owner_id === U.staffA)!;
      expect(+mine.won_amount).toBe(700);
      expect(+mine.open_amount).toBe(90);
    });
  });
  it("sales cycle averages days from creation to close", async () => {
    await as("ownerA", async (q) => {
      const id = await deal(q, U.ownerA, 100, "won");
      await switchTo(q, "owner");
      await q("set local session_replication_role = replica");
      await q("update opportunities set created_at = now() - interval '10 days', closed_at = now() where id = $1", [id]);
      await q("set local session_replication_role = origin");
      await switchTo(q, "ownerA");
      const c = await q(`select * from report_sales_cycle($1, ${R})`, [ids.acme]);
      expect(+c[0]!.avg_days).toBe(10);
      expect(+c[0]!.median_days).toBe(10);
    });
  });
  it("stage ageing measures time in the current stage", async () => {
    await as("ownerA", async (q) => {
      const id = await deal(q, U.ownerA, 100);
      await switchTo(q, "owner");
      await q("set local session_replication_role = replica");
      await q("update opportunity_history set at = now() - interval '4 days' where opportunity_id = $1", [id]);
      await q("set local session_replication_role = origin");
      const a = await q("select * from report_stage_ageing($1)", [ids.acme]);
      expect(a[0]).toMatchObject({ stage: "Qualification" });
      expect(a[0]!.open_deals).toBe(1);
      expect(+a[0]!.avg_days).toBeCloseTo(4, 0);
    });
  });
  it("staff see only their own numbers; another workspace sees nothing", async () => {
    await as("ownerA", async (q) => {
      await deal(q, U.ownerA, 111, "won"); await deal(q, U.staffA, 222, "won");
      await switchTo(q, "staffA");
      const p = await q(`select * from report_seller_performance($1, ${R})`, [ids.acme]);
      expect(p.map((x) => x.owner_id)).toEqual([U.staffA]);
      await switchTo(q, "ownerB");
      expect(await q(`select * from report_seller_performance($1, ${R})`, [ids.acme])).toHaveLength(0);
      expect(await q(`select * from report_losses($1, ${R})`, [ids.acme])).toHaveLength(0);
    });
  });
});

describe("saved views", () => {
  it("private by default, shareable, never editable by others, isolated per workspace", async () => {
    await as("managerA", async (q) => {
      await q("insert into saved_views (tenant_id, report, name, params) values ($1, 'losses', 'Mine', '{}'), ($1, 'funnel', 'Team', '{}')", [ids.acme]);
      await q("update saved_views set shared = true where name = 'Team'");
      await switchTo(q, "ownerA");
      expect((await q("select name from saved_views")).map((r) => r.name)).toEqual(["Team"]);
      expect(await q("update saved_views set name = 'Hijack' returning id")).toHaveLength(0);
      expect(await q("delete from saved_views returning id")).toHaveLength(0);
      await switchTo(q, "ownerB");
      expect(await q("select 1 from saved_views")).toHaveLength(0);
    });
  });
});
