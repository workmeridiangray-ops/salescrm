import { beforeAll, describe, expect, it } from "vitest";
import { as, failure, ids, seed, switchTo, U, type Q } from "./helpers";

beforeAll(seed);
const TO = "current_date + 1", FROM = "current_date - 30";
const mkKey = async (q: Q, scopes = ["read:accounts", "read:leads", "write:leads"], tenant = ids.acme) =>
  (await q("select create_api_key($1, 'CI', $2) k", [tenant, scopes]))[0]!.k as string;
const list = (q: Q, key: string, entity: string, limit = 50, after: string | null = null) =>
  q("select api_list($1, $2, $3, $4) r", [key, entity, limit, after]).then((x) => x[0]!.r as { data: any[]; next: string | null });

describe("API keys", () => {
  it("only api.manage holders create/revoke keys; the key is stored hashed and shown once", async () => {
    await as("managerA", async (q) => {
      expect(await failure(q("select create_api_key($1, 'x', array['read:accounts'])", [ids.acme]))).toBe("forbidden");
    });
    await as("ownerA", async (q) => {
      const key = await mkKey(q);
      expect(key).toMatch(/^sk_live_[0-9a-f]{64}$/);
      const row = (await q("select key_prefix from api_keys"))[0]!;
      expect(row.key_prefix).toBe(key.slice(0, 12));
      await switchTo(q, "owner");
      const hash = (await q("select key_hash from api_keys limit 1"))[0]!.key_hash as string;
      expect(hash).not.toContain(key);
      await switchTo(q, "ownerA");
      expect(await failure(q("select key_hash from api_keys"))).toMatch(/permission denied/);
      expect(await failure(q("select create_api_key($1, 'bad', array['read:everything'])", [ids.acme]))).toMatch(/check/);
    });
  });

  it("returns only the key's own workspace, honours scopes, and paginates by cursor", async () => {
    await as("ownerA", async (q) => {
      for (let i = 0; i < 5; i++) await q("insert into accounts (tenant_id, name) values ($1, $2)", [ids.acme, `API Co ${i}`]);
      await q("insert into accounts (tenant_id, name, owner_id) values ($1, 'Globex Secret', null)", [ids.globex]).catch(() => undefined);
      const key = await mkKey(q);
      await switchTo(q, "owner");
      await q("insert into accounts (tenant_id, name, owner_id) values ($1, 'Globex Hidden', null)", [ids.globex]);
      await q("set local role anon");  // API callers are anonymous to Supabase; the key is the credential
      const p1 = await list(q, key, "accounts", 3);
      expect(p1.data).toHaveLength(3);
      expect(p1.next).not.toBeNull();
      const p2 = await list(q, key, "accounts", 3, p1.next);
      const names = [...p1.data, ...p2.data].map((r) => r.name);
      expect(names.some((n) => /Globex/.test(n))).toBe(false);
      expect(new Set(names).size).toBe(names.length);
      expect(Object.keys(p1.data[0])).not.toContain("tenant_id");
      expect(await failure(list(q, key, "contacts"))).toBe("insufficient_scope");
      expect(await failure(list(q, key, "users"))).toBe("unknown_entity");
    });
  });

  it("unknown, malformed, revoked and suspended-workspace keys are all just 'unauthorized'", async () => {
    await as("ownerA", async (q) => {
      const key = await mkKey(q);
      const id = (await q("select id from api_keys"))[0]!.id;
      await switchTo(q, "owner");
      await q("set local role anon");
      expect(await failure(list(q, "sk_live_nope", "accounts"))).toBe("unauthorized");
      expect(await failure(list(q, "", "accounts"))).toBe("unauthorized");
      await switchTo(q, "ownerA");
      await q("select revoke_api_key($1, $2)", [ids.acme, id]);
      await switchTo(q, "owner");
      await q("set local role anon");
      expect(await failure(list(q, key, "accounts"))).toBe("unauthorized");
    });
    await as("ownerA", async (q) => {
      const key = await mkKey(q);
      await switchTo(q, "owner");
      await q("update tenants set status = 'suspended' where id = $1", [ids.acme]);
      await q("set local role anon");
      expect(await failure(list(q, key, "accounts"))).toBe("unauthorized");
    });
  });

  it("rate limits per key per minute", async () => {
    await as("ownerA", async (q) => {
      const key = await mkKey(q);
      const id = (await q("select id from api_keys"))[0]!.id;
      await switchTo(q, "owner");
      await q("insert into api_usage (key_id, minute, hits) values ($1, date_trunc('minute', now()), 119)", [id]);
      await q("set local role anon");
      await list(q, key, "accounts");   // 120th call is allowed
      expect(await failure(list(q, key, "accounts"))).toBe("rate_limited");
    });
  });

  it("a write key can create leads (deduped and assigned); a read-only key cannot", async () => {
    await as("ownerA", async (q) => {
      const w = await mkKey(q), r = await mkKey(q, ["read:leads"]);
      await switchTo(q, "owner");
      await q("set local role anon");
      const call = (k: string) => q("select api_create_lead($1, 'API Lead', 'api@bigco.test', 'BigCo', null, 'hi')", [k]);
      await call(w);
      await call(w);
      expect(await failure(call(r))).toBe("insufficient_scope");
      await q("reset role");
      const rows = await q("select source, owner_id from leads where email = 'api@bigco.test'");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source).toBe("web");
      expect(rows[0]!.owner_id).not.toBeNull();
    });
  });

  it("another workspace's owner cannot see or revoke these keys", async () => {
    await as("ownerA", async (q) => {
      await mkKey(q);
      const id = (await q("select id from api_keys"))[0]!.id;
      await switchTo(q, "ownerB");
      expect(await q("select 1 from api_keys")).toHaveLength(0);
      expect(await failure(q("select revoke_api_key($1, $2)", [ids.globex, id]))).toBe("api_key_not_found");
      expect(await failure(q("select revoke_api_key($1, $2)", [ids.acme, id]))).toBe("forbidden");
    });
  });
});
void U;
