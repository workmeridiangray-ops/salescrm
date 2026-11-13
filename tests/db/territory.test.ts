import { beforeAll, describe, expect, it } from "vitest";
import { as, EMAIL, failure, ids, seed, switchTo, U, type Q } from "./helpers";

beforeAll(seed);
const lead = (q: Q, email: string) => q("select capture_lead('acme', 'Web Lead', $1, null, null, null)", [email]);
const ownerOf = async (q: Q, email: string) => (await q("select owner_id from leads where email = $1", [email]))[0]!.owner_id as string;

describe("territory rules", () => {
  it("route web leads by email domain; first matching rule wins; unmatched leads use round robin", async () => {
    await as("managerA", async (q) => {
      await q("select add_territory_rule($1, 'bigco.example.org', $2)", [ids.acme, U.staffA]);
      await q("select add_territory_rule($1, 'example.org', $2)", [ids.acme, U.managerA]);   // broader, later
      await lead(q, "a@bigco.example.org"); await lead(q, "b@sub.bigco.example.org"); await lead(q, "c@other.example.org"); await lead(q, "d@nomatch.test");
      expect(await ownerOf(q, "a@bigco.example.org")).toBe(U.staffA);
      expect(await ownerOf(q, "b@sub.bigco.example.org")).toBe(U.staffA);        // sub-domains match
      expect(await ownerOf(q, "c@other.example.org")).toBe(U.managerA);          // falls to the second rule
      expect(await ownerOf(q, "d@nomatch.test")).not.toBeNull();             // round robin
    });
  });
  it("reordering changes which rule wins", async () => {
    await as("managerA", async (q) => {
      const a = (await q("select add_territory_rule($1, 'big.example.org', $2) id", [ids.acme, U.staffA]))[0]!.id;
      await q("select add_territory_rule($1, 'example.org', $2)", [ids.acme, U.managerA]);
      await lead(q, "x@big.example.org");
      expect(await ownerOf(q, "x@big.example.org")).toBe(U.staffA);
      await q("select move_territory_rule($1, $2, 1)", [ids.acme, a]);
      await lead(q, "y@big.example.org");
      expect(await ownerOf(q, "y@big.example.org")).toBe(U.managerA);
      expect((await q("select position from territory_rules order by position")).map((r) => r.position)).toEqual([0, 1]);
    });
  });
  it("a rule whose owner is no longer an active writer is skipped, never assigns to them", async () => {
    await as("managerA", async (q) => {
      await q("select add_territory_rule($1, 'gone.example', $2)", [ids.acme, U.staffA]);
      await switchTo(q, "owner");
      await q("update memberships set status = 'suspended' where user_id = $1", [U.staffA]);
      await lead(q, "z@gone.example");
      expect(await ownerOf(q, "z@gone.example")).not.toBe(U.staffA);
    });
  });
  it("apply routes only unassigned open leads and never takes a lead from its owner", async () => {
    await as("managerA", async (q) => {
      await q("select add_territory_rule($1, 'acme-fans.example', $2)", [ids.acme, U.staffA]);
      await q("insert into leads (tenant_id, name, email, owner_id) values ($1, 'Free', 'free@acme-fans.example', null), ($1, 'Held', 'held@acme-fans.example', $2)", [ids.acme, U.managerA]);
      expect((await q("select apply_territory_rules($1) n", [ids.acme]))[0]!.n).toBe(1);
      expect(await ownerOf(q, "free@acme-fans.example")).toBe(U.staffA);
      expect(await ownerOf(q, "held@acme-fans.example")).toBe(U.managerA);
    });
  });
  it("only reassigners manage rules; owners must be active writers; domains are validated; other workspaces are isolated", async () => {
    await as("staffA", async (q) => {
      expect(await failure(q("select add_territory_rule($1, 'x.example', $2)", [ids.acme, U.staffA]))).toBe("forbidden");
      expect(await q("select 1 from territory_rules")).toHaveLength(0);
    });
    await as("managerA", async (q) => {
      expect(await failure(q("select add_territory_rule($1, 'x.example', $2)", [ids.acme, U.ownerB]))).toBe("owner_not_member");
      expect(await failure(q("select add_territory_rule($1, 'not a domain', $2)", [ids.acme, U.staffA]))).toMatch(/check/);
      const id = (await q("select add_territory_rule($1, 'iso.example', $2) id", [ids.acme, U.staffA]))[0]!.id;
      await switchTo(q, "ownerB");
      expect(await q("select 1 from territory_rules")).toHaveLength(0);
      expect(await failure(q("select delete_territory_rule($1, $2)", [ids.globex, id]))).toBe("rule_not_found");
    });
  });
});

describe("report schedules", () => {
  const mk = (q: Q, recipients: string[], freq = "weekly") => q("select create_report_schedule($1, 'losses', 30, $2, $3) id", [ids.acme, freq, recipients]);
  it("only exporters with workspace-wide access can schedule, and only to active members", async () => {
    await as("managerA", async (q) => {
      expect(await failure(mk(q, [EMAIL.managerA]))).toBe("forbidden");   // managers lack crm.export by default
    });
    await as("ownerA", async (q) => {
      expect(await failure(mk(q, ["outsider@else.test"]))).toBe("recipient_not_member");
      await switchTo(q, "owner");
      await q("update memberships set status = 'suspended' where user_id = $1", [U.staffA]);
      await switchTo(q, "ownerA");
      expect(await failure(mk(q, [EMAIL.staffA]))).toBe("recipient_not_member");
      const id = (await mk(q, [EMAIL.ownerA, EMAIL.managerA.toUpperCase()]))[0]!.id;
      const s = (await q("select recipients, next_run_at > now() as future from report_schedules where id = $1", [id]))[0]!;
      expect(s.recipients.sort()).toEqual([EMAIL.managerA, EMAIL.ownerA].sort());
      expect(s.future).toBe(true);
    });
  });
  it("next run is a Monday 07:00 IST (weekly) or the 1st (monthly)", async () => {
    await as("ownerA", async (q) => {
      await switchTo(q, "owner");
      const w = (await q("select app.next_run('weekly', '2026-11-12 10:00+00') t, extract(isodow from (app.next_run('weekly', '2026-11-12 10:00+00') at time zone 'Asia/Kolkata')) d, to_char(app.next_run('weekly') at time zone 'Asia/Kolkata', 'HH24:MI') h"))[0]!;
      expect(+w.d).toBe(1);
      expect(w.h).toBe("07:00");
      const m = (await q("select to_char(app.next_run('monthly', '2026-12-20 10:00+00') at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') t"))[0]!.t;
      expect(m).toBe("2027-01-01 07:00");
    });
  });
  it("the dispatcher claims due schedules once and moves them forward; suspended workspaces are skipped", async () => {
    await as("ownerA", async (q) => {
      const id = (await mk(q, [EMAIL.ownerA]))[0]!.id;
      await switchTo(q, "owner");
      await q("update report_schedules set next_run_at = now() - interval '1 minute' where id = $1", [id]);
      await q("set local role service_role");
      const c1 = await q("select * from report_schedules_claim(10)");
      expect(c1).toHaveLength(1);
      expect(c1[0]).toMatchObject({ report: "losses", range_days: 30, tenant_name: "Acme Distribution" });
      expect(await q("select * from report_schedules_claim(10)")).toHaveLength(0);
      await q("select report_schedule_result($1, 'boom')", [id]);
      await q("reset role");
      const s = (await q("select last_error, next_run_at > now() as future, last_run_at is not null as ran from report_schedules where id = $1", [id]))[0]!;
      expect(s).toEqual({ last_error: "boom", future: true, ran: true });
      await q("update report_schedules set next_run_at = now() - interval '1 minute' where id = $1", [id]);
      await q("update tenants set status = 'suspended' where id = $1", [ids.acme]);
      await q("set local role service_role");
      expect(await q("select * from report_schedules_claim(10)")).toHaveLength(0);
    });
  });
  it("clients cannot claim; staff and other workspaces cannot see schedules; deleting stops them", async () => {
    await as("ownerA", async (q) => {
      const id = (await mk(q, [EMAIL.ownerA]))[0]!.id;
      expect(await failure(q("select * from report_schedules_claim(1)"))).toMatch(/permission denied/);
      await switchTo(q, "staffA");
      expect(await q("select 1 from report_schedules")).toHaveLength(0);
      await switchTo(q, "ownerB");
      expect(await q("select 1 from report_schedules")).toHaveLength(0);
      await switchTo(q, "ownerA");
      await q("select delete_report_schedule($1, $2)", [ids.acme, id]);
      expect((await q("select active from report_schedules where id = $1", [id]))[0]!.active).toBe(false);
    });
  });
});
