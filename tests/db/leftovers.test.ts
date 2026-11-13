import { beforeAll, describe, expect, it } from "vitest";
import { as, failure, ids, seed, switchTo, U, type Q } from "./helpers";

beforeAll(seed);
const stages = (q: Q, pipeline: string) => q("select id, name, position, kind, probability from stages where pipeline_id = $1 order by position", [pipeline]);
const mainPipeline = async (q: Q, t = ids.acme) => (await q("select id from pipelines where tenant_id = $1 order by created_at limit 1", [t]))[0]!.id as string;

describe("duplicate merge", () => {
  it("finds likely duplicates, previews conflicts, and merges links without losing data", async () => {
    await as("ownerA", async (q) => {
      const a1 = (await q("insert into accounts (tenant_id, name, domain) values ($1, 'Acme Traders Pvt Ltd', 'acme-t.test') returning id", [ids.acme]))[0]!.id;
      const a2 = (await q("insert into accounts (tenant_id, name, industry) values ($1, 'ACME Traders', 'Retail') returning id", [ids.acme]))[0]!.id;
      const c = (await q("insert into contacts (tenant_id, account_id, full_name, email) values ($1, $2, 'Meera', 'm@acme-t.test') returning id", [ids.acme, a2]))[0]!.id;
      const s = (await q("select id, pipeline_id from stages where tenant_id = $1 and kind = 'open' limit 1", [ids.acme]))[0]!;
      const o = (await q("insert into opportunities (tenant_id, name, account_id, pipeline_id, stage_id) values ($1, 'Deal', $2, $3, $4) returning id", [ids.acme, a2, s.pipeline_id, s.id]))[0]!.id;
      const dup = await q("select * from find_duplicates($1, 'accounts')", [ids.acme]);
      expect(dup).toHaveLength(1);
      expect(dup[0]!.reason).toBe("Similar name");
      const pv = (await q("select preview_merge('accounts', $1, $2) p", [a1, a2]))[0]!.p as any[];
      expect(pv.find((f) => f.field === "industry")).toMatchObject({ conflict: false, filled_from_removed: true });
      expect(pv.find((f) => f.field === "name")).toMatchObject({ conflict: true });
      await q("select merge_records('accounts', $1, $2)", [a1, a2]);
      expect((await q("select account_id from contacts where id = $1", [c]))[0]!.account_id).toBe(a1);
      expect((await q("select account_id from opportunities where id = $1", [o]))[0]!.account_id).toBe(a1);
      expect((await q("select domain, industry, archived_at is null as live from accounts where id = $1", [a1]))[0]).toEqual({ domain: "acme-t.test", industry: "Retail", live: true });
      expect((await q("select archived_at is not null as gone from accounts where id = $1", [a2]))[0]!.gone).toBe(true);
      expect((await q("select removed_snapshot->>'name' n from merge_log"))[0]!.n).toBe("ACME Traders");
      expect(await failure(q("select merge_records('accounts', $1, $1)", [a1]))).toBe("same_record");
    });
  });
  it("contact merge keeps the survivor's data, fills gaps, frees the unique email", async () => {
    await as("ownerA", async (q) => {
      const k = (await q("insert into contacts (tenant_id, full_name, phone) values ($1, 'Ravi K', '999') returning id", [ids.acme]))[0]!.id;
      const r = (await q("insert into contacts (tenant_id, full_name, email, phone, job_title, opted_out) values ($1, 'Ravi Kumar', 'ravi@k.test', '888', 'CTO', true) returning id", [ids.acme]))[0]!.id;
      await q("select merge_records('contacts', $1, $2)", [k, r]);
      expect((await q("select email, phone, job_title, opted_out from contacts where id = $1", [k]))[0]).toEqual({ email: "ravi@k.test", phone: "999", job_title: "CTO", opted_out: true });
    });
  });
  it("cannot merge across workspaces or without write access to both", async () => {
    await as("ownerA", async (q) => {
      await q("insert into accounts (tenant_id, name, owner_id) values ($1, 'Globex Acct', null)", [ids.globex]).catch(() => undefined);
      const a = (await q("insert into accounts (tenant_id, name, owner_id) values ($1, 'Mine', $2) returning id", [ids.acme, U.ownerA]))[0]!.id;
      const b = (await q("insert into accounts (tenant_id, name, owner_id) values ($1, 'Theirs', $2) returning id", [ids.acme, U.managerA]))[0]!.id;
      await switchTo(q, "owner");
      const g = (await q("insert into accounts (tenant_id, name, owner_id) values ($1, 'Globex Acct', null) returning id", [ids.globex]))[0]!.id;
      await switchTo(q, "ownerA");
      expect(await failure(q("select merge_records('accounts', $1, $2)", [a, g]))).toBe("record_not_found");
      await switchTo(q, "staffA");
      expect(await failure(q("select merge_records('accounts', $1, $2)", [a, b]))).toBe("record_not_found");
    });
  });
});

describe("stages and pipelines", () => {
  it("templates create ready-to-use pipelines; limit is 5; only configurers can", async () => {
    await as("managerA", async (q) => {
      const id = (await q("select create_pipeline($1, 'Distribution', 'distribution') id", [ids.acme]))[0]!.id;
      expect((await stages(q, id)).map((s) => [s.name, s.kind])).toEqual([["Enquiry", "open"], ["Quote sent", "open"], ["PO expected", "open"], ["Won", "won"], ["Lost", "lost"]]);
      expect(await failure(q("select create_pipeline($1, 'X', 'nope')", [ids.acme]))).toMatch(/invalid_request/);
      for (const n of ["B", "C", "D"]) await q("select create_pipeline($1, $2, 'blank')", [ids.acme, n]);
      expect(await failure(q("select create_pipeline($1, 'F', 'blank')", [ids.acme]))).toBe("pipeline_limit");
    });
    await as("staffA", async (q) => {
      expect(await failure(q("select create_pipeline($1, 'S', 'blank')", [ids.acme]))).toBe("forbidden");
    });
  });
  it("add, rename, reorder and delete keep terminal stages last and positions contiguous", async () => {
    await as("managerA", async (q) => {
      const p = await mainPipeline(q);
      const sid = (await q("select add_stage($1, $2, 'Demo', 25) id", [ids.acme, p]))[0]!.id;
      let s = await stages(q, p);
      expect(s.map((x) => x.name)).toEqual(["Qualification", "Proposal", "Negotiation", "Demo", "Won", "Lost"]);
      expect(s.map((x) => x.position)).toEqual([0, 1, 2, 3, 4, 5]);
      await q("select move_stage($1, $2, -1)", [ids.acme, sid]);
      await q("select move_stage($1, $2, -1)", [ids.acme, sid]);
      await q("select update_stage($1, $2, 'Product demo', 30)", [ids.acme, sid]);
      s = await stages(q, p);
      expect(s.map((x) => x.name)).toEqual(["Qualification", "Product demo", "Proposal", "Negotiation", "Won", "Lost"]);
      expect(s[1]!.probability).toBe(30);
      await q("select move_stage($1, $2, 1)", [ids.acme, s[3]!.id]);   // already last open stage: no-op
      await q("select delete_stage($1, $2)", [ids.acme, sid]);
      expect((await stages(q, p)).map((x) => x.position)).toEqual([0, 1, 2, 3, 4]);
    });
  });
  it("guards: probability range, terminal stages, stages in use, last open stage, other workspaces", async () => {
    await as("ownerA", async (q) => {
      const p = await mainPipeline(q);
      const s = await stages(q, p);
      expect(await failure(q("select add_stage($1, $2, 'Bad', 100)", [ids.acme, p]))).toBe("invalid_probability");
      expect(await failure(q("select add_stage($1, $2, 'Bad', 0)", [ids.acme, p]))).toBe("invalid_probability");
      expect(await failure(q("select delete_stage($1, $2)", [ids.acme, s[3]!.id]))).toBe("terminal_stage");
      const o = await q("select id, pipeline_id from stages where id = $1", [s[0]!.id]);
      await q("insert into opportunities (tenant_id, name, pipeline_id, stage_id) values ($1, 'x', $2, $3)", [ids.acme, o[0]!.pipeline_id, s[0]!.id]);
      expect(await failure(q("select delete_stage($1, $2)", [ids.acme, s[0]!.id]))).toBe("stage_in_use");
      const bp = (await q("select create_pipeline($1, 'Solo', 'blank') id", [ids.acme]))[0]!.id;
      const only = (await stages(q, bp))[0]!;
      expect(await failure(q("select delete_stage($1, $2)", [ids.acme, only.id]))).toBe("last_open_stage");
      await switchTo(q, "ownerB");
      expect(await failure(q("select update_stage($1, $2, 'Hijack', 50)", [ids.globex, s[0]!.id]))).toBe("stage_not_found");
      expect(await failure(q("select add_stage($1, $2, 'Hijack', 50)", [ids.globex, p]))).toBe("pipeline_not_found");
    });
  });
  it("stage history survives a probability change (forecast uses the current value)", async () => {
    await as("ownerA", async (q) => {
      const p = await mainPipeline(q);
      const s = (await stages(q, p))[0]!;
      await q("select update_stage($1, $2, $3, 55)", [ids.acme, s.id, s.name]);
      expect((await q("select probability from stages where id = $1", [s.id]))[0]!.probability).toBe(55);
      expect((await q("select action from audit_log where action = 'stage.updated' order by id desc limit 1"))[0]!.action).toBe("stage.updated");
    });
  });
});

describe("custom fields", () => {
  const def = (q: Q, entity: string, key: string, type: string, opts: string[] = [], required = false) =>
    q("select create_custom_field($1, $2, $3, $3, $4, $5, $6) id", [ids.acme, entity, key, type, opts, required]);
  it("typed values are validated; unknown keys and wrong types are rejected", async () => {
    await as("ownerA", async (q) => {
      await def(q, "accounts", "employees", "number"); await def(q, "accounts", "tier", "select", ["gold", "silver"]);
      await def(q, "accounts", "renewal", "date"); await def(q, "accounts", "vip", "checkbox"); await def(q, "accounts", "note", "text");
      const ok = { employees: 120, tier: "gold", renewal: "2027-03-01", vip: true, note: "hi" };
      await q("insert into accounts (tenant_id, name, custom) values ($1, 'C1', $2)", [ids.acme, JSON.stringify(ok)]);
      for (const [bad, why] of [[{ employees: "many" }, "number"], [{ tier: "bronze" }, "select"], [{ renewal: "tomorrow" }, "date"], [{ vip: "yes" }, "checkbox"], [{ ghost: 1 }, "unknown"], [{ note: "x".repeat(501) }, "length"]] as const)
        expect(await failure(q("insert into accounts (tenant_id, name, custom) values ($1, 'C2', $2)", [ids.acme, JSON.stringify(bad)])), why).toMatch(/custom_field_(invalid|unknown)/);
    });
  });
  it("required fields are enforced on create and on changing values; hidden fields keep their data", async () => {
    await as("ownerA", async (q) => {
      const f = (await def(q, "contacts", "segment", "text", [], true))[0]!.id;
      expect(await failure(q("insert into contacts (tenant_id, full_name) values ($1, 'No seg')", [ids.acme]))).toMatch(/custom_field_required/);
      const c = (await q("insert into contacts (tenant_id, full_name, custom) values ($1, 'Has seg', '{\"segment\":\"smb\"}') returning id", [ids.acme]))[0]!.id;
      await q("select set_custom_field_active($1, $2, false)", [ids.acme, f]);
      await q("insert into contacts (tenant_id, full_name) values ($1, 'After hide')", [ids.acme]);
      expect((await q("select custom from contacts where id = $1", [c]))[0]!.custom).toEqual({ segment: "smb" });
      await q("update contacts set job_title = 'x' where id = $1", [c]);
    });
  });
  it("definitions are per workspace, limited to 20 per entity, and owner-only", async () => {
    await as("ownerA", async (q) => {
      for (let i = 0; i < 20; i++) await def(q, "leads", `f${i}`, "text");
      expect(await failure(def(q, "leads", "f20", "text"))).toBe("custom_field_limit");
      expect(await failure(def(q, "leads", "f0", "text"))).toMatch(/custom_field_defs_tenant_id_entity_key_key|custom_field_limit/);
      await switchTo(q, "ownerB");
      expect(await q("select 1 from custom_field_defs")).toHaveLength(0);
      expect(await failure(q("insert into leads (tenant_id, name, custom) values ($1, 'L', '{\"f0\":\"x\"}')", [ids.globex]))).toMatch(/custom_field_unknown/);
    });
    await as("managerA", async (q) => {
      expect(await failure(def(q, "accounts", "x1", "text"))).toBe("forbidden");
    });
  });
});

describe("support access", () => {
  it("platform support sees only counts and recent audit, only while a grant is live, and every view is logged", async () => {
    await as("ownerA", async (q) => {
      await q("insert into audit_log (tenant_id, action, entity) values ($1, 'seed', 'x')", [ids.acme]).catch(() => undefined);
      await switchTo(q, "owner");
      await q("insert into platform_staff (user_id, role) values ($1, 'support'), ($2, 'billing')", [U.outsider, U.invitee]);
      await switchTo(q, "outsider");
      expect(await failure(q("select platform_support_summary($1)", [ids.acme]))).toBe("no_support_grant");
      await switchTo(q, "managerA");
      expect(await failure(q("select grant_support_access($1, 4, 'Help with import')", [ids.acme]))).toBe("forbidden");
      await switchTo(q, "ownerA");
      const g = (await q("select grant_support_access($1, 4, 'Help with import') id", [ids.acme]))[0]!.id;
      await switchTo(q, "outsider");
      const s = (await q("select platform_support_summary($1) s", [ids.acme]))[0]!.s;
      expect(s).toMatchObject({ grant_note: "Help with import", members: 3 });
      expect(Object.keys(s)).not.toContain("accounts_list");
      await switchTo(q, "invitee");   // billing role: not support
      expect(await failure(q("select platform_support_summary($1)", [ids.acme]))).toBe("forbidden");
      await switchTo(q, "ownerA");
      expect((await q("select action from audit_log where action = 'support.summary_viewed'"))).toHaveLength(1);
      await q("select revoke_support_access($1, $2)", [ids.acme, g]);
      await switchTo(q, "outsider");
      expect(await failure(q("select platform_support_summary($1)", [ids.acme]))).toBe("no_support_grant");
    });
  });
  it("grants expire", async () => {
    await as("ownerA", async (q) => {
      await q("select grant_support_access($1, 1, 'x')", [ids.acme]);
      await switchTo(q, "owner");
      await q("insert into platform_staff (user_id, role) values ($1, 'support')", [U.outsider]);
      await q("update support_grants set expires_at = now() - interval '1 minute'");
      await switchTo(q, "outsider");
      expect(await failure(q("select platform_support_summary($1)", [ids.acme]))).toBe("no_support_grant");
    });
  });
});

describe("closure and purge", () => {
  it("only the owner can request closure, with the slug typed; the workspace keeps working; owner can cancel", async () => {
    await as("managerA", async (q) => {
      expect(await failure(q("select request_closure($1, 'acme')", [ids.acme]))).toBe("forbidden");
    });
    await as("ownerA", async (q) => {
      expect(await failure(q("select request_closure($1, 'wrong')", [ids.acme]))).toBe("confirmation_mismatch");
      const when = (await q("select request_closure($1, ' ACME ') w", [ids.acme]))[0]!.w as Date;
      expect(when.getTime()).toBeGreaterThan(Date.now() + 29 * 86400000);
      await q("insert into accounts (tenant_id, name) values ($1, 'Still works')", [ids.acme]);   // exports and edits stay available
      await q("select cancel_closure($1)", [ids.acme]);
      expect((await q("select closure_requested_at from tenants where id = $1", [ids.acme]))[0]!.closure_requested_at).toBeNull();
      expect(await failure(q("select cancel_closure($1)", [ids.acme]))).toBe("no_closure_pending");
    });
  });
  it("purge removes only workspaces past 30 days, only for platform owners, and keeps the audit trail", async () => {
    await as("ownerB", async (q) => {
      await q("select request_closure($1, 'globex')", [ids.globex]);
      await switchTo(q, "owner");
      await q("insert into platform_staff (user_id, role) values ($1, 'owner'), ($2, 'support')", [U.outsider, U.invitee]);
      await switchTo(q, "ownerB");
      expect(await failure(q("select platform_purge_closed()"))).toBe("forbidden");
      await switchTo(q, "outsider");
      expect((await q("select platform_purge_closed() n"))[0]!.n).toBe(0);   // only 0 days old
      await switchTo(q, "owner");
      await q("update tenants set closure_requested_at = now() - interval '31 days' where id = $1", [ids.globex]);
      await switchTo(q, "invitee");
      expect(await failure(q("select platform_purge_closed()"))).toBe("forbidden");   // support cannot purge
      await switchTo(q, "outsider");
      expect((await q("select platform_purge_closed() n"))[0]!.n).toBe(1);
      await switchTo(q, "owner");
      expect(await q("select 1 from tenants where id = $1", [ids.globex])).toHaveLength(0);
      expect(await q("select 1 from accounts where tenant_id = $1", [ids.globex])).toHaveLength(0);
      expect((await q("select action from audit_log where tenant_id = $1 and action = 'platform.purged'", [ids.globex]))).toHaveLength(1);
      expect(await q("select 1 from tenants where id = $1", [ids.acme])).toHaveLength(1);
    });
  });
});
