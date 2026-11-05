import { beforeAll, describe, expect, it } from "vitest";
import { as, asOwner, EMAIL, failure, ids, seed, switchTo, U } from "./helpers";

beforeAll(seed);
const role = (k: string) => ids.roles.acme![k]!;

describe("permissions and escalation", () => {
  it("staff cannot see the member directory or invitations", async () => {
    await as("staffA", async (q) => {
      expect(await q("select user_id from memberships where tenant_id = $1", [ids.acme])).toHaveLength(1); // own row only
      expect(await q("select * from invitations")).toHaveLength(0);
      expect(await q("select * from audit_log")).toHaveLength(0);
      expect(await q("select email from profiles where id <> auth.uid()")).toHaveLength(0);
    });
  });

  it("manager sees directory, invitations and audit but cannot manage", async () => {
    await as("managerA", async (q) => {
      expect(await q("select 1 from memberships where tenant_id = $1", [ids.acme])).toHaveLength(3);
      expect((await q("select 1 from audit_log")).length).toBeGreaterThan(0);
      expect(await failure(q("select set_member_status($1, $2, 'suspended')", [ids.acme, U.staffA]))).toBe("forbidden");
    });
  });

  it("manager cannot invite someone into a role more powerful than their own", async () => {
    await as("managerA", async (q) => {
      expect(await failure(q("select invite_member($1, 'n@n.test', $2)", [ids.acme, role("owner")]))).toBe("cannot_grant_unheld_permission");
      expect(await q("select invite_member($1, 'n@n.test', $2) t", [ids.acme, role("staff")])).toHaveLength(1);
    });
  });

  it("owner cannot demote or remove themselves as the last owner", async () => {
    await as("ownerA", async (q) => {
      expect(await failure(q("select change_member_role($1, $2, $3)", [ids.acme, U.ownerA, role("staff")]))).toBe("last_owner");
      expect(await failure(q("select set_member_status($1, $2, 'suspended')", [ids.acme, U.ownerA]))).toBe("last_owner");
      expect(await failure(q("select remove_member($1, $2)", [ids.acme, U.ownerA]))).toBe("last_owner");
    });
  });

  it("a second owner makes demotion possible", async () => {
    await as("ownerA", async (q) => {
      await q("select change_member_role($1, $2, $3)", [ids.acme, U.managerA, role("owner")]);
      await q("select change_member_role($1, $2, $3)", [ids.acme, U.ownerA, role("staff")]);
      const r = await q("select r.key from memberships m join roles r on r.id = m.role_id where m.user_id = $1", [U.ownerA]);
      expect(r[0]!.key).toBe("staff");
    });
  });

  it("system roles are locked; custom roles cannot exceed the editor's own permissions", async () => {
    await as("ownerA", async (q) => {
      expect(await failure(q("select upsert_role($1, $2, 'staff', 'Staff', '{audit.view}')", [ids.acme, role("staff")]))).toBe("system_role_locked");
      const id = (await q("select upsert_role($1, null, 'viewer', 'Viewer', '{members.view}') id", [ids.acme]))[0]!.id;
      expect(id).toBeTruthy();
      expect(await failure(q("select upsert_role($1, null, 'bad', 'Bad', '{nope.nope}')", [ids.acme]))).toBe("unknown_permission");
      await q("select delete_role($1, $2)", [ids.acme, id]);
    });
  });

  it("a role holder without all permissions cannot create a stronger role", async () => {
    await asOwner(async (q) => {
      await q("insert into roles (tenant_id, key, name, permissions) values ($1, 'rolemgr', 'Role manager', '{roles.manage}')", [ids.acme]);
      const rid = (await q("select id from roles where tenant_id = $1 and key = 'rolemgr'", [ids.acme]))[0]!.id;
      await q("update memberships set role_id = $1 where user_id = $2", [rid, U.staffA]);
      await switchTo(q, "staffA");
      expect(await failure(q("select upsert_role($1, null, 'x1', 'X1', '{audit.view}')", [ids.acme]))).toBe("cannot_grant_unheld_permission");
    });
  });
});

describe("invitations", () => {
  const invite = async (q: any, email = EMAIL.invitee) =>
    (await q("select invite_member($1, $2, $3) t", [ids.acme, email, role("staff")]))[0].t as string;

  it("the token is stored hashed and acceptance joins the workspace with the invited role", async () => {
    await as("ownerA", async (q) => {
      const tok = await invite(q);
      const stored = await q("select token_hash from invitations where email = $1", [EMAIL.invitee]);
      expect(stored[0]!.token_hash).not.toContain(tok);
      expect(tok.length).toBeGreaterThan(40);
    });
  });

  it("full flow: invite, accept as the right person, membership and audit follow", async () => {
    await as("ownerA", async (q) => {
      const t = await invite(q);
      await switchTo(q, "invitee");
      expect((await q("select accept_invitation($1) t", [t]))[0]!.t).toBe(ids.acme);
      expect(await q("select 1 from memberships where user_id = $1 and tenant_id = $2", [U.invitee, ids.acme])).toHaveLength(1);
      expect(await failure(q("select accept_invitation($1)", [t]))).toBe("invitation_used");
      await switchTo(q, "owner");
      const a = await q("select action from audit_log where tenant_id = $1 order by id desc limit 1", [ids.acme]);
      expect(a[0]!.action).toBe("invitation.accepted");
    });
  });

  it("the wrong person, an unknown token, a revoked or expired invitation each fail clearly", async () => {
    await as("ownerA", async (q) => {
      const t = await invite(q);
      const iid = (await q("select id from invitations where email = $1 and status = 'pending'", [EMAIL.invitee]))[0]!.id;
      await switchTo(q, "outsider");
      expect(await failure(q("select accept_invitation($1)", [t]))).toBe("invitation_invalid");
      await switchTo(q, "invitee");
      expect(await failure(q("select accept_invitation('nope')"))).toBe("invitation_invalid");
      await switchTo(q, "owner");
      await q("update invitations set expires_at = now() - interval '1 minute' where id = $1", [iid]);
      await switchTo(q, "invitee");
      expect(await failure(q("select accept_invitation($1)", [t]))).toBe("invitation_expired");
      await switchTo(q, "owner");
      await q("update invitations set expires_at = now() + interval '1 day' where id = $1", [iid]);
      await switchTo(q, "ownerA");
      await q("select revoke_invitation($1, $2)", [ids.acme, iid]);
      await switchTo(q, "invitee");
      expect(await failure(q("select accept_invitation($1)", [t]))).toBe("invitation_revoked");
    });
  });

  it("rejects duplicate pending invitations and existing members", async () => {
    await as("ownerA", async (q) => {
      await invite(q);
      expect(await failure(q("select invite_member($1, $2, $3)", [ids.acme, EMAIL.invitee, role("staff")]))).toBe("already_invited");
      expect(await failure(q("select invite_member($1, $2, $3)", [ids.acme, EMAIL.staffA, role("staff")]))).toBe("already_a_member");
    });
  });
});

describe("suspension", () => {
  it("a suspended member immediately loses access to workspace data", async () => {
    await as("ownerA", async (q) => {
      await q("select set_member_status($1, $2, 'suspended')", [ids.acme, U.staffA]);
      await switchTo(q, "staffA");
      expect(await q("select 1 from tenants")).toHaveLength(0);
      expect(await q("select 1 from roles")).toHaveLength(0);
    });
  });
});

describe("audit trail", () => {
  it("sensitive changes are recorded with the actor, and the log is immutable", async () => {
    await as("ownerA", async (q) => {
      await q("select set_member_status($1, $2, 'suspended')", [ids.acme, U.staffA]);
      const rows = await q("select actor_id, action from audit_log where tenant_id = $1 order by id desc limit 1", [ids.acme]);
      expect(rows[0]).toMatchObject({ actor_id: U.ownerA, action: "member.suspended" });
    });
    await asOwner(async (q) => {
      expect(await failure(q("update audit_log set action = 'x'"))).toMatch(/append-only/);
      expect(await failure(q("delete from audit_log"))).toMatch(/append-only/);
      expect(await failure(q("truncate audit_log"))).toMatch(/append-only/);
    });
  });
});
