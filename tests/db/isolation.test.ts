import { beforeAll, describe, expect, it } from "vitest";
import { as, asOwner, failure, ids, seed, switchTo } from "./helpers";

beforeAll(seed);

describe("tenant isolation (reads)", () => {
  it("a member sees only their own workspace", async () => {
    const rows = await as("ownerA", (q) => q("select slug from tenants"));
    expect(rows.map((r) => r.slug)).toEqual(["acme"]);
  });

  it("another tenant's rows are invisible in every table, even with a guessed id", async () => {
    await as("ownerA", async (q) => {
      const g = ids.globex;
      expect(await q("select * from tenants where id = $1", [g])).toHaveLength(0);
      expect(await q("select * from roles where tenant_id = $1", [g])).toHaveLength(0);
      expect(await q("select * from memberships where tenant_id = $1", [g])).toHaveLength(0);
      expect(await q("select * from invitations where tenant_id = $1", [g])).toHaveLength(0);
      expect(await q("select * from audit_log where tenant_id = $1", [g])).toHaveLength(0);
      expect(await q("select * from profiles where id = (select id from profiles where email = 'owner@globex.test')")).toHaveLength(0);
    });
  });

  it("a user with no workspace sees nothing", async () => {
    await as("outsider", async (q) => {
      for (const t of ["tenants", "roles", "memberships", "invitations", "audit_log"]) {
        expect(await q(`select 1 from ${t}`), t).toHaveLength(0);
      }
    });
  });

  it("anonymous callers cannot read or call anything", async () => {
    await as(null, async (q) => {
      expect(await failure(q("select * from tenants"))).toMatch(/permission denied/);
      expect(await failure(q("select create_workspace('x y', 'xy')"))).toMatch(/permission denied/);
    });
  });
});

describe("tenant isolation (writes)", () => {
  it("direct table writes are refused for signed-in users", async () => {
    await as("ownerA", async (q) => {
      for (const sql of [
        "insert into tenants (name, slug) values ('Evil', 'evil')",
        "update tenants set name = 'Hacked'",
        "delete from memberships",
        "update roles set permissions = '{}'",
        "insert into audit_log (tenant_id, action, entity) values (gen_random_uuid(), 'x', 'y')",
      ]) {
        expect(await failure(q(sql)), sql).toMatch(/permission denied/);
      }
    });
  });

  it("RPCs on another tenant fail without revealing anything", async () => {
    await as("ownerA", async (q) => {
      const g = ids.globex;
      for (const sql of [
        `select update_workspace('${g}', 'Mine now')`,
        `select invite_member('${g}', 'x@y.test', '${ids.roles.globex!.staff}')`,
        `select upsert_role('${g}', null, 'sneaky', 'Sneaky', '{}')`,
        `select set_member_status('${g}', '${"b0000000-0000-4000-8000-000000000001"}', 'suspended')`,
      ]) {
        expect(await failure(q(sql)), sql).toBe("forbidden");
      }
    });
  });

  it("a role from another tenant cannot be attached (composite foreign key)", async () => {
    const msg = await asOwner((q) =>
      failure(q("update memberships set role_id = $1 where tenant_id = $2 and user_id = $3",
        [ids.roles.globex!.owner, ids.acme, "a0000000-0000-4000-8000-000000000003"])));
    expect(msg).toMatch(/foreign key/);
  });

  it("owner of Acme cannot grant a Globex role through invite or role change", async () => {
    await as("ownerA", async (q) => {
      expect(await failure(q("select invite_member($1, 'z@z.test', $2)", [ids.acme, ids.roles.globex!.staff]))).toBe("role_not_found");
      expect(await failure(q("select change_member_role($1, $2, $3)",
        [ids.acme, "a0000000-0000-4000-8000-000000000003", ids.roles.globex!.owner]))).toBe("role_not_found");
    });
  });

  it("suspended workspace blocks its members", async () => {
    await asOwner(async (q) => {
      await q("update tenants set status = 'suspended' where id = $1", [ids.acme]);
      await switchTo(q, "ownerA");
      const msg = await failure(q("select update_workspace($1, 'Renamed')", [ids.acme]));
      expect(msg).toBe("forbidden");
    });
  });
});
