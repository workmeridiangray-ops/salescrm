import { beforeAll, describe, expect, it } from "vitest";
import { calcQuote } from "@/lib/rules/quote";
import { as, failure, ids, seed, switchTo, U, type Q } from "./helpers";

beforeAll(seed);

const mkOpp = async (q: Q, tenant = ids.acme) => {
  const s = (await q("select id, pipeline_id from stages where tenant_id = $1 and kind = 'open' order by position limit 1", [tenant]))[0]!;
  return (await q("insert into opportunities (tenant_id, name, pipeline_id, stage_id, amount) values ($1, 'Deal', $2, $3, 1) returning id", [tenant, s.pipeline_id, s.id]))[0]!.id as string;
};
const mkQuote = async (q: Q, opp: string, tenant = ids.acme, lines: [number, number, number][] = [[2, 1000, 18]]) => {
  const id = (await q("select create_quote($1) id", [opp]))[0]!.id as string;
  for (const [qty, price, rate] of lines)
    await q("insert into quote_lines (tenant_id, quote_id, description, qty, unit_price, tax_rate) values ($1, $2, 'Item', $3, $4, $5)", [tenant, id, qty, price, rate]);
  return id;
};
const state = async (q: Q, id: string) => (await q("select * from quotes where id = $1", [id]))[0]!;

describe("totals", () => {
  it("database totals equal the TypeScript rule, including rounding edges", async () => {
    const cases: { lines: [number, number, number][]; d: number }[] = [
      { lines: [[2, 1000, 18]], d: 0 },
      { lines: [[1, 1000, 18]], d: 10 },
      { lines: [[0.5, 0.05, 0], [3.333, 10, 5]], d: 50 },
      { lines: [[1.5, 999.99, 12], [4, 250, 5], [7, 13.37, 28]], d: 7.5 },
      { lines: [[1, 0.01, 18]], d: 33.33 },
    ];
    await as("ownerA", async (q) => {
      const opp = await mkOpp(q);
      for (const c of cases) {
        const id = await mkQuote(q, opp, ids.acme, c.lines);
        await q("update quotes set discount_pct = $1 where id = $2", [c.d, id]);
        const s = await state(q, id);
        const ts = calcQuote(c.lines.map(([qty, unitPrice, taxRate]) => ({ qty, unitPrice, taxRate })), c.d);
        expect({ s: +s.subtotal, d: +s.discount_total, t: +s.tax_total, tot: +s.total }).toEqual({ s: ts.subtotal, d: ts.discountTotal, t: ts.taxTotal, tot: ts.total });
      }
    });
  });
  it("numbers are sequential per workspace; versions share the number", async () => {
    await as("ownerA", async (q) => {
      const opp = await mkOpp(q);
      const a = await state(q, await mkQuote(q, opp));
      const b = await state(q, await mkQuote(q, opp));
      expect(+b.number.slice(2)).toBe(+a.number.slice(2) + 1);
    });
  });
});

describe("workflow", () => {
  it("under-threshold quotes are auto-approved; over-threshold wait for an approver", async () => {
    await as("ownerA", async (q) => {
      const opp = await mkOpp(q);
      const small = await mkQuote(q, opp);
      await q("update quotes set discount_pct = 10 where id = $1", [small]);
      expect((await q("select submit_quote($1) s", [small]))[0]!.s).toBe("approved");
      const big = await mkQuote(q, opp);
      await q("update quotes set discount_pct = 10.5 where id = $1", [big]);
      expect((await q("select submit_quote($1) s", [big]))[0]!.s).toBe("pending_approval");
    });
  });

  it("empty quotes cannot be submitted; submitted quotes are locked", async () => {
    await as("ownerA", async (q) => {
      const opp = await mkOpp(q);
      const empty = await mkQuote(q, opp, ids.acme, []);
      expect(await failure(q("select submit_quote($1)", [empty]))).toBe("quote_empty");
      const id = await mkQuote(q, opp);
      await q("select submit_quote($1)", [id]);
      expect(await failure(q("update quotes set discount_pct = 90 where id = $1", [id]))).toMatch(/quote_locked/);
      expect(await failure(q("insert into quote_lines (tenant_id, quote_id, description, qty, unit_price) values ($1, $2, 'x', 1, 1)", [ids.acme, id]))).toMatch(/quote_locked/);
      expect(await failure(q("delete from quote_lines where quote_id = $1", [id]))).toMatch(/quote_locked/);
      expect(await failure(q("update quotes set status = 'accepted' where id = $1", [id]))).toMatch(/permission denied/);
    });
  });

  it("approval: staff cannot approve; the author cannot self-approve (unless owner); rejection needs a reason", async () => {
    await as("staffA", async (q) => {
      const opp = await mkOpp(q);
      const id = await mkQuote(q, opp);
      await q("update quotes set discount_pct = 25 where id = $1", [id]);
      await q("select submit_quote($1)", [id]);
      expect(await failure(q("select approve_quote($1)", [id]))).toBe("forbidden");
      await switchTo(q, "managerA");
      await q("select approve_quote($1)", [id]);
      expect((await state(q, id)).status).toBe("approved");
    });
    await as("managerA", async (q) => {
      const opp = await mkOpp(q);
      const id = await mkQuote(q, opp);
      await q("update quotes set discount_pct = 25 where id = $1", [id]);
      await q("select submit_quote($1)", [id]);
      expect(await failure(q("select approve_quote($1)", [id]))).toBe("self_approval");
      await switchTo(q, "ownerA");
      expect(await failure(q("select reject_quote_approval($1, '  ')", [id]))).toBe("reason_required");
      await q("select reject_quote_approval($1, 'Margin too thin')", [id]);
      const s = await state(q, id);
      expect(s).toMatchObject({ status: "draft", decision_reason: "Margin too thin" });
    });
  });

  it("send -> customer reviews without an account -> accepts -> opportunity is won at the quoted total", async () => {
    await as("ownerA", async (q) => {
      const opp = await mkOpp(q);
      const id = await mkQuote(q, opp);
      await q("select submit_quote($1)", [id]);
      const tok = (await q("select send_quote($1) t", [id]))[0]!.t as string;
      expect((await state(q, id)).review_token_hash).not.toContain(tok);
      await switchTo(q, "owner");
      await q("set local role anon");
      const view = (await q("select quote_for_review($1) v", [tok]))[0]!.v;
      expect(view).toMatchObject({ status: "sent", total: 2360, company: "Acme Distribution" });
      expect((await q("select quote_for_review('nope') v"))[0]!.v).toBeNull();
      expect(await failure(q("select respond_to_quote($1, true, '', null)", [tok]))).toBe("name_required");
      expect((await q("select respond_to_quote($1, true, 'Priya Rao', null) r", [tok]))[0]!.r).toBe("accepted");
      expect(await failure(q("select respond_to_quote($1, false, 'Priya Rao', null)", [tok]))).toBe("quote_already_answered");
      await q("reset role");
      const o = (await q("select status, amount from opportunities where id = $1", [opp]))[0]!;
      expect(o).toMatchObject({ status: "won", amount: "2360.00" });
      expect((await state(q, id)).responded_by_name).toBe("Priya Rao");
    });
  });

  it("an expired quote cannot be accepted", async () => {
    await as("ownerA", async (q) => {
      const opp = await mkOpp(q);
      const id = await mkQuote(q, opp);
      await q("select submit_quote($1)", [id]);
      const tok = (await q("select send_quote($1) t", [id]))[0]!.t as string;
      await switchTo(q, "owner");
      await q("set local session_replication_role = replica");  // simulate time passing without tripping the lock trigger
      await q("update quotes set valid_until = current_date - 1 where id = $1", [id]);
      await q("set local session_replication_role = origin");
      await q("set local role anon");
      expect((await q("select quote_for_review($1) v", [tok]))[0]!.v.expired).toBe(true);
      expect(await failure(q("select respond_to_quote($1, true, 'X', null)", [tok]))).toBe("quote_expired");
    });
  });

  it("revision: new version, old superseded and its link dead; accepted quotes need an approver", async () => {
    await as("staffA", async (q) => {
      const opp = await mkOpp(q);
      const id = await mkQuote(q, opp);
      await q("select submit_quote($1)", [id]);
      const tok = (await q("select send_quote($1) t", [id]))[0]!.t as string;
      const v2 = (await q("select revise_quote($1) id", [id]))[0]!.id as string;
      const [a, b] = [await state(q, id), await state(q, v2)];
      expect(a.status).toBe("superseded");
      expect(b).toMatchObject({ status: "draft", version: 2, number: a.number });
      expect((await q("select count(*)::int n from quote_lines where quote_id = $1", [v2]))[0]!.n).toBe(1);
      await switchTo(q, "owner");
      await q("set local role anon");
      expect((await q("select quote_for_review($1) v", [tok]))[0]!.v).toBeNull();
      await switchTo(q, "staffA");
      expect(await failure(q("select revise_quote($1)", [id]))).toMatch(/quote_not_revisable/);
      await q("select submit_quote($1)", [v2]);
      const t2 = (await q("select send_quote($1) t", [v2]))[0]!.t as string;
      await switchTo(q, "owner");
      await q("set local role anon");
      await q("select respond_to_quote($1, true, 'Buyer', null)", [t2]);
      await switchTo(q, "staffA");
      expect(await failure(q("select revise_quote($1)", [v2]))).toBe("revision_needs_approval");
      await switchTo(q, "managerA");  // approvers may take the change-process route
      const v3 = (await q("select revise_quote($1) id", [v2]))[0]!.id as string;
      expect((await state(q, v3)).version).toBe(3);
    });
  });
});

describe("isolation and visibility", () => {
  it("staff see only their own quotes; another workspace is invisible and unreachable", async () => {
    await as("ownerA", async (q) => {
      const opp = await mkOpp(q);
      const id = await mkQuote(q, opp);
      await switchTo(q, "staffA");
      expect(await q("select 1 from quotes where id = $1", [id])).toHaveLength(0);
      expect(await q("select 1 from quote_lines where quote_id = $1", [id])).toHaveLength(0);
      expect(await failure(q("select submit_quote($1)", [id]))).toBe("quote_not_found");
      await switchTo(q, "ownerB");
      expect(await q("select 1 from quotes")).toHaveLength(0);
      expect(await failure(q("select send_quote($1)", [id]))).toBe("quote_not_found");
      await switchTo(q, "owner");
      expect(await failure(q("insert into quote_lines (tenant_id, quote_id, description, qty, unit_price) values ($1, $2, 'x', 1, 1)", [ids.globex, id]))).toMatch(/foreign key/);
    });
  });
  it("only product managers edit the catalogue; members can read it", async () => {
    await as("staffA", async (q) => {
      expect(await failure(q("insert into products (tenant_id, name, unit_price) values ($1, 'X', 1)", [ids.acme]))).toMatch(/row-level security/);
    });
    await as("managerA", async (q) => {
      await q("insert into products (tenant_id, sku, name, unit_price) values ($1, 'SKU-1', 'Widget', 100)", [ids.acme]);
      expect(await failure(q("insert into products (tenant_id, sku, name, unit_price) values ($1, 'sku-1', 'Dup', 1)", [ids.acme]))).toMatch(/products_sku_unique/);
      await switchTo(q, "staffA");
      expect(await q("select 1 from products")).toHaveLength(1);
      await switchTo(q, "ownerB");
      expect(await q("select 1 from products")).toHaveLength(0);
    });
  });
  it("threshold is owner-configurable only", async () => {
    await as("managerA", async (q) => {
      expect(await failure(q("select set_discount_threshold($1, 5)", [ids.acme]))).toBe("forbidden");
      await switchTo(q, "ownerA");
      await q("select set_discount_threshold($1, 5)", [ids.acme]);
      expect(await failure(q("select set_discount_threshold($1, 101)", [ids.acme]))).toMatch(/invalid_request/);
    });
  });
});
void U;
