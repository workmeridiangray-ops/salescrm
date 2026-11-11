import { beforeAll, describe, expect, it } from "vitest";
import { as, failure, ids, seed, switchTo, U, type Q } from "./helpers";

beforeAll(seed);

const mkOpp = async (q: Q, owner: string, tenant = ids.acme, amount = 5000) => {
  const s = (await q("select id, pipeline_id from stages where tenant_id = $1 and kind = 'open' order by position limit 1", [tenant]))[0]!;
  return (await q("insert into opportunities (tenant_id, name, pipeline_id, stage_id, amount, owner_id) values ($1, 'Big deal', $2, $3, $4, $5) returning id", [tenant, s.pipeline_id, s.id, amount, owner]))[0]!.id as string;
};
const win = async (q: Q, opp: string, tenant = ids.acme) => {
  const w = (await q("select id from stages where tenant_id = $1 and kind = 'won'", [tenant]))[0]!.id;
  await q("update opportunities set stage_id = $1 where id = $2", [w, opp]);
};
const handoverOf = async (q: Q, opp: string) => (await q("select * from handovers where opportunity_id = $1", [opp]))[0]!;

describe("teams", () => {
  it("a team lead sees and can work on their team's records, but not others'", async () => {
    await as("ownerA", async (q) => {
      const t = (await q("insert into teams (tenant_id, name) values ($1, 'North') returning id", [ids.acme]))[0]!.id;
      await q("insert into team_members (tenant_id, team_id, user_id, is_lead) values ($1, $2, $3, true), ($1, $2, $4, false)", [ids.acme, t, U.staffA, U.managerA]);
      await q("insert into accounts (tenant_id, name, owner_id) values ($1, 'Mgr Co', $2), ($1, 'Owner Co', $3)", [ids.acme, U.managerA, U.ownerA]);
      await switchTo(q, "staffA");  // staff, but lead of North
      expect((await q("select name from accounts order by name")).map((r) => r.name)).toEqual(["Mgr Co"]);
      expect(await q("update accounts set industry = 'x' where name = 'Mgr Co' returning id")).toHaveLength(1);
      expect(await q("update accounts set industry = 'x' where name = 'Owner Co' returning id")).toHaveLength(0);
    });
  });
  it("non-leads gain nothing from team membership; only member managers edit teams; other workspaces can't join", async () => {
    await as("ownerA", async (q) => {
      const t = (await q("insert into teams (tenant_id, name) values ($1, 'South') returning id", [ids.acme]))[0]!.id;
      await q("insert into team_members (tenant_id, team_id, user_id, is_lead) values ($1, $2, $3, false)", [ids.acme, t, U.staffA]);
      await q("insert into accounts (tenant_id, name, owner_id) values ($1, 'Mgr2', $2)", [ids.acme, U.managerA]);
      await switchTo(q, "staffA");
      expect(await q("select 1 from accounts where name = 'Mgr2'")).toHaveLength(0);
      expect(await failure(q("insert into teams (tenant_id, name) values ($1, 'Mine')", [ids.acme]))).toMatch(/row-level security/);
      await switchTo(q, "owner");
      expect(await failure(q("insert into team_members (tenant_id, team_id, user_id) values ($1, $2, $3)", [ids.globex, t, U.ownerB]))).toMatch(/foreign key/);
    });
  });
});

describe("reassignment", () => {
  it("moves live records, leaves closed ones, is audited, and refuses bad targets", async () => {
    await as("ownerA", async (q) => {
      const open = await mkOpp(q, U.staffA);
      const won = await mkOpp(q, U.staffA);
      await win(q, won);
      await q("insert into accounts (tenant_id, name, owner_id) values ($1, 'Leaver Co', $2)", [ids.acme, U.staffA]);
      await q("insert into activities (tenant_id, subject, owner_id) values ($1, 'call back', $2)", [ids.acme, U.staffA]);
      await switchTo(q, "managerA");
      const w = (await q("select member_workload($1, $2) w", [ids.acme, U.staffA]))[0]!.w;
      expect(w).toMatchObject({ accounts: 1, opportunities: 1, open_tasks: 1 });
      expect(await failure(q("select reassign_records($1, $2, $2)", [ids.acme, U.staffA]))).toBe("same_person");
      expect(await failure(q("select reassign_records($1, $2, $3)", [ids.acme, U.staffA, U.ownerB]))).toBe("owner_not_member");
      const r = (await q("select reassign_records($1, $2, $3) r", [ids.acme, U.staffA, U.managerA]))[0]!.r;
      expect(r).toMatchObject({ accounts: 1, opportunities: 1, open_tasks: 1 });
      expect((await q("select owner_id from opportunities where id = $1", [open]))[0]!.owner_id).toBe(U.managerA);
      expect((await q("select owner_id from opportunities where id = $1", [won]))[0]!.owner_id).toBe(U.staffA);
      const a = await q("select action, actor_id from audit_log where action = 'records.reassigned' order by id desc limit 1");
      expect(a[0]).toMatchObject({ actor_id: U.managerA });
    });
  });
  it("staff cannot reassign; nobody can reach into another workspace", async () => {
    await as("staffA", async (q) => {
      expect(await failure(q("select reassign_records($1, $2, $3)", [ids.acme, U.ownerA, U.staffA]))).toBe("forbidden");
    });
    await as("ownerA", async (q) => {
      expect(await failure(q("select reassign_records($1, $2, $3)", [ids.globex, U.ownerB, U.ownerA]))).toBe("forbidden");
    });
  });
});

describe("handover", () => {
  it("winning a deal creates one handover with a checklist and the accepted quote's terms", async () => {
    await as("ownerA", async (q) => {
      const opp = await mkOpp(q, U.ownerA);
      const quote = (await q("select create_quote($1) id", [opp]))[0]!.id;
      await q("insert into quote_lines (tenant_id, quote_id, description, qty, unit_price) values ($1, $2, 'Item', 1, 1000)", [ids.acme, quote]);
      await q("select submit_quote($1)", [quote]);
      const tok = (await q("select send_quote($1) t", [quote]))[0]!.t;
      await switchTo(q, "owner");
      await q("set local role anon");
      await q("select respond_to_quote($1, true, 'Priya', null)", [tok]);
      await q("reset role");
      const h = await handoverOf(q, opp);
      expect(h.commercial_terms).toMatch(/Q-\d+ v1 accepted by Priya\. Total INR 1180\.00/);
      expect(h.quote_id).toBe(quote);
      expect(await q("select 1 from handover_items where handover_id = $1", [h.id])).toHaveLength(5);
      await win(q, opp);  // already won: no duplicate
      expect(await q("select 1 from handovers where opportunity_id = $1", [opp])).toHaveLength(1);
    });
  });
  it("completion needs every item; completed handovers are frozen", async () => {
    await as("ownerA", async (q) => {
      const opp = await mkOpp(q, U.ownerA);
      await win(q, opp);
      const h = await handoverOf(q, opp);
      expect(await failure(q("select complete_handover($1)", [h.id]))).toBe("handover_incomplete");
      const items = await q("select id from handover_items where handover_id = $1", [h.id]);
      for (const i of items) await q("select set_handover_item($1, true)", [i.id]);
      expect((await handoverOf(q, opp)).status).toBe("in_progress");
      await q("select complete_handover($1)", [h.id]);
      expect(await failure(q("select set_handover_item($1, false)", [items[0]!.id]))).toBe("handover_already_complete");
      expect(await failure(q("select complete_handover($1)", [h.id]))).toBe("handover_already_complete");
    });
  });
  it("handovers follow the opportunity's visibility, and status cannot be edited directly", async () => {
    await as("ownerA", async (q) => {
      const opp = await mkOpp(q, U.ownerA);
      await win(q, opp);
      const h = await handoverOf(q, opp);
      await switchTo(q, "staffA");
      expect(await q("select 1 from handovers where id = $1", [h.id])).toHaveLength(0);
      expect(await failure(q("select complete_handover($1)", [h.id]))).toBe("handover_not_found");
      await switchTo(q, "ownerB");
      expect(await q("select 1 from handovers")).toHaveLength(0);
      await switchTo(q, "ownerA");
      expect(await failure(q("update handovers set status = 'complete' where id = $1", [h.id]))).toMatch(/permission denied/);
      await q("update handovers set scope = 'Deliver 10 widgets', escalated_reason = 'Customer wants it sooner' where id = $1", [h.id]);
    });
  });
});

describe("renewals", () => {
  it("a renewal starts from a won deal, links back, and inherits the account", async () => {
    await as("ownerA", async (q) => {
      const acct = (await q("insert into accounts (tenant_id, name) values ($1, 'Renew Co') returning id", [ids.acme]))[0]!.id;
      const opp = await mkOpp(q, U.ownerA);
      await q("update opportunities set account_id = $1 where id = $2", [acct, opp]);
      expect(await failure(q("select create_renewal($1, '2027-12-01')", [opp]))).toBe("opportunity_not_won");
      await win(q, opp);
      const nid = (await q("select create_renewal($1, '2027-12-01') id", [opp]))[0]!.id;
      const r = (await q("select kind, account_id, source_opportunity_id, status, expected_close, next_action from opportunities where id = $1", [nid]))[0]!;
      expect(r).toMatchObject({ kind: "renewal", account_id: acct, source_opportunity_id: opp, status: "open" });
      expect(r.next_action).toMatch(/renewal/);
      expect(await failure(q("select create_renewal($1, '2027-12-01', 'bogus')", [opp]))).toMatch(/invalid_request/);
    });
  });
  it("cannot renew someone else's deal you cannot see", async () => {
    await as("ownerA", async (q) => {
      const opp = await mkOpp(q, U.ownerA);
      await win(q, opp);
      await switchTo(q, "staffA");
      expect(await failure(q("select create_renewal($1, '2027-12-01')", [opp]))).toBe("opportunity_not_found");
    });
  });
});
