import { beforeAll, describe, expect, it } from "vitest";
import { as, failure, ids, seed, switchTo } from "./helpers";

beforeAll(seed);
const imp = (q: any, entity: string, rows: object[], tenant = ids.acme) =>
  q("select import_rows($1, $2, $3::jsonb) r", [tenant, entity, JSON.stringify(rows)]).then((x: any) => x[0].r);

describe("import_rows", () => {
  it("imports good rows, reports each bad row, and never stops at the first failure", async () => {
    await as("ownerA", async (q) => {
      await q("insert into accounts (tenant_id, name) values ($1, 'Existing')", [ids.acme]);
      const r = await imp(q, "accounts", [
        { _line: 2, name: "Fresh One", domain: "FRESH.test" }, { _line: 3, name: "existing" }, { _line: 4, name: "Fresh Two" }, { _line: 5, name: "Fresh One" },
      ]);
      expect(r).toMatchObject({ total: 4, imported: 2 });
      expect(r.failed.map((f: any) => f.row)).toEqual([3, 5]);
      expect(r.failed[0].error).toMatch(/accounts_name_unique/);
      expect((await q("select domain, source from accounts where name = 'Fresh One'"))[0]).toEqual({ domain: "fresh.test", source: "import" });
      const job = (await q("select imported, failed, total from import_jobs order by created_at desc limit 1"))[0]!;
      expect(job).toEqual({ imported: 2, failed: 2, total: 4 });
    });
  });
  it("re-importing the same file is safe: nothing is duplicated", async () => {
    await as("ownerA", async (q) => {
      const rows = [{ _line: 2, name: "A", email: "a@imp.test" }, { _line: 3, name: "B", email: "b@imp.test" }];
      expect((await imp(q, "contacts", rows)).imported).toBe(2);
      const again = await imp(q, "contacts", rows);
      expect(again).toMatchObject({ imported: 0 });
      expect(await q("select 1 from contacts where email like '%@imp.test'")).toHaveLength(2);
    });
  });
  it("contacts link to accounts by name inside the workspace only", async () => {
    await as("ownerB", async (q) => { await q("insert into accounts (tenant_id, name) values ($1, 'Globex Only')", [ids.globex]); });
    await as("ownerA", async (q) => {
      await q("insert into accounts (tenant_id, name) values ($1, 'Linked')", [ids.acme]);
      const r = await imp(q, "contacts", [{ _line: 2, name: "X", email: "x@l.test", account: "linked" }, { _line: 3, name: "Y", email: "y@l.test", account: "Globex Only" }]);
      expect(r.imported).toBe(1);
      expect(r.failed[0]).toMatchObject({ row: 3 });
      expect(r.failed[0].error).toMatch(/account_not_found/);
    });
  });
  it("leads import as owned by the importer and are scored", async () => {
    await as("staffA", async (q) => {
      await imp(q, "leads", [{ _line: 2, name: "L", email: "l@bigco.test", company: "BigCo" }]);
      const l = (await q("select owner_id, source, score from leads where email = 'l@bigco.test'"))[0]!;
      expect(l).toMatchObject({ source: "import", score: 50 });
    });
  });
  it("refuses another workspace, oversized batches and unknown entities", async () => {
    await as("ownerA", async (q) => {
      expect(await failure(imp(q, "accounts", [{ name: "Evil" }], ids.globex))).toBe("forbidden");
      expect(await failure(imp(q, "accounts", Array.from({ length: 2001 }, (_, i) => ({ name: `n${i}` }))))).toBe("too_many_rows");
      expect(await failure(imp(q, "users", []))).toMatch(/invalid_request/);
    });
  });
  it("import history is visible to managers and the importer only", async () => {
    await as("staffA", async (q) => { await imp(q, "accounts", [{ name: "Staff import" }]); });
    await as("staffA", async (q) => {
      await imp(q, "accounts", [{ _line: 2, name: "Staff import 2" }]);
      expect(await q("select 1 from import_jobs")).toHaveLength(1);
      await switchTo(q, "managerA");
      expect((await q("select 1 from import_jobs")).length).toBe(1);
      await switchTo(q, "ownerB");
      expect(await q("select 1 from import_jobs")).toHaveLength(0);
    });
  });
});

describe("export audit", () => {
  it("only crm.export holders can log an export; it is audited with the row count", async () => {
    await as("managerA", async (q) => {
      expect(await failure(q("select log_export($1, 'accounts', 10)", [ids.acme]))).toBe("forbidden");
    });
    await as("ownerA", async (q) => {
      await q("select log_export($1, 'accounts', 10)", [ids.acme]);
      const a = (await q("select detail from audit_log where action = 'export.downloaded' order by id desc limit 1"))[0]!;
      expect(a.detail).toEqual({ rows: 10 });
    });
  });
});
