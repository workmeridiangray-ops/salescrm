import { beforeAll, describe, expect, it } from "vitest";
import { as, failure, ids, seed, switchTo, U, type Q } from "./helpers";

beforeAll(seed);
const PERIOD = "2027-03";

async function deal(q: Q, owner: string, stageIdx: number, amount: number, close = `${PERIOD}-15`, tenant = ids.acme) {
  const s = (await q("select id, pipeline_id from stages where tenant_id = $1 order by position offset $2 limit 1", [tenant, stageIdx]))[0]!;
  return (await q("insert into opportunities (tenant_id, name, pipeline_id, stage_id, amount, expected_close, owner_id) values ($1, 'D', $2, $3, $4, $5, $6) returning id",
    [tenant, s.pipeline_id, s.id, amount, close, owner]))[0]!.id as string;
}
const rows = (q: Q, t = ids.acme) => q("select * from forecast_rows($1, $2)", [t, PERIOD]);

describe("calculated forecast", () => {
  it("buckets by stage probability, weights by it, and only counts the period", async () => {
    await as("ownerA", async (q) => {
      await deal(q, U.ownerA, 0, 1000);                 // 10%  -> pipeline
      await deal(q, U.ownerA, 1, 2000);                 // 40%  -> best case
      await deal(q, U.ownerA, 2, 4000);                 // 70%  -> commit
      await deal(q, U.ownerA, 2, 9999, "2027-04-01");   // next month: ignored
      const r = (await rows(q)).find((x) => x.owner_id === U.ownerA)!;
      expect({ c: +r.commit_amount, b: +r.best_case_amount, p: +r.pipeline_amount, w: +r.weighted, n: r.open_count })
        .toEqual({ c: 4000, b: 2000, p: 1000, w: 100 + 800 + 2800, n: 3 });
    });
  });
  it("won deals count in the month they closed, not their expected date", async () => {
    await as("ownerA", async (q) => {
      const id = await deal(q, U.ownerA, 2, 5000, "2020-01-01");
      const won = (await q("select id from stages where tenant_id = $1 and kind = 'won'", [ids.acme]))[0]!.id;
      await q("update opportunities set stage_id = $1 where id = $2", [won, id]);
      const month = new Date().toISOString().slice(0, 7);
      const r = (await q("select * from forecast_rows($1, $2)", [ids.acme, month])).find((x) => x.owner_id === U.ownerA)!;
      expect(+r.won).toBe(5000);
      const closed = (await q("select closed_at from opportunities where id = $1", [id]))[0]!.closed_at;
      expect(closed).not.toBeNull();
    });
  });
  it("staff see only their own numbers; managers see everyone's", async () => {
    await as("ownerA", async (q) => {
      await deal(q, U.ownerA, 2, 100);
      await deal(q, U.staffA, 2, 200);
      await switchTo(q, "staffA");
      expect((await rows(q)).map((r) => r.owner_id)).toEqual([U.staffA]);
      await switchTo(q, "managerA");
      expect((await rows(q)).length).toBe(2);
      await switchTo(q, "ownerB");
      expect(await rows(q)).toHaveLength(0);
      expect(await rows(q, ids.globex)).toHaveLength(0);
    });
  });
});

describe("targets, overrides, snapshots", () => {
  it("only forecast managers can set targets and overrides; overrides need a reason and keep history", async () => {
    await as("staffA", async (q) => {
      expect(await failure(q("select set_forecast_target($1, $2, null, 1)", [ids.acme, PERIOD]))).toBe("forbidden");
      expect(await failure(q("select set_forecast_override($1, $2, $3, 'commit', 1, 'x')", [ids.acme, PERIOD, U.staffA]))).toBe("forbidden");
    });
    await as("managerA", async (q) => {
      await q("select set_forecast_target($1, $2, null, 100000)", [ids.acme, PERIOD]);
      await q("select set_forecast_target($1, $2, null, 120000)", [ids.acme, PERIOD]);
      expect(await q("select amount from forecast_targets where period = $1", [PERIOD])).toEqual([{ amount: "120000.00" }]);
      expect(await failure(q("select set_forecast_override($1, $2, $3, 'commit', 5, ' ')", [ids.acme, PERIOD, U.staffA]))).toBe("reason_required");
      await q("select set_forecast_override($1, $2, $3, 'commit', 5, 'Verbal yes')", [ids.acme, PERIOD, U.staffA]);
      await q("select set_forecast_override($1, $2, $3, 'commit', 7, 'Revised')", [ids.acme, PERIOD, U.staffA]);
      expect(await q("select amount from forecast_overrides order by id")).toHaveLength(2);
      expect(await failure(q("update forecast_overrides set amount = 1"))).toMatch(/permission denied/);
      expect(await failure(q("select set_forecast_override($1, $2, $3, 'commit', 5, 'r')", [ids.acme, PERIOD, U.ownerB]))).toBe("owner_not_member");
    });
  });
  it("snapshots capture the numbers at that moment and cannot be altered", async () => {
    await as("ownerA", async (q) => {
      await deal(q, U.ownerA, 2, 4000);
      const sid = (await q("select take_forecast_snapshot($1, $2) id", [ids.acme, PERIOD]))[0]!.id;
      await deal(q, U.ownerA, 2, 6000);   // after the snapshot
      const snap = (await q("select data from forecast_snapshots where id = $1", [sid]))[0]!.data as any[];
      expect(+snap.find((r) => r.owner_id === U.ownerA).commit_amount).toBe(4000);
      expect(+(await rows(q)).find((r) => r.owner_id === U.ownerA)!.commit_amount).toBe(10000);
      expect(await failure(q("update forecast_snapshots set data = '[]'"))).toMatch(/permission denied/);
      await switchTo(q, "staffA");
      expect(await q("select 1 from forecast_snapshots")).toHaveLength(0);
      expect(await failure(q("select take_forecast_snapshot($1, $2)", [ids.acme, PERIOD]))).toBe("forbidden");
      await switchTo(q, "ownerB");
      expect(await q("select 1 from forecast_snapshots")).toHaveLength(0);
    });
  });
  it("rejects malformed periods", async () => {
    await as("ownerA", async (q) => {
      expect(await failure(q("select set_forecast_target($1, '2027-13', null, 1)", [ids.acme]))).toMatch(/check/);
    });
  });
});
