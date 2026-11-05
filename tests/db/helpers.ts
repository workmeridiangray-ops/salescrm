/**
 * Runs queries as a real signed-in user: switches to the `authenticated` role
 * and sets request.jwt.claims the way PostgREST does, so auth.uid() and every
 * RLS policy behave as in production. `as()` always rolls back; the one-time
 * seed uses `commitAs()`.
 */
import pg from "pg";

export const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
export const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });

export const U = {
  ownerA: "a0000000-0000-4000-8000-000000000001",
  managerA: "a0000000-0000-4000-8000-000000000002",
  staffA: "a0000000-0000-4000-8000-000000000003",
  ownerB: "b0000000-0000-4000-8000-000000000001",
  outsider: "c0000000-0000-4000-8000-000000000001",
  invitee: "c0000000-0000-4000-8000-000000000002",
} as const;
export type UserKey = keyof typeof U;
export const EMAIL: Record<UserKey, string> = {
  ownerA: "owner@acme.test", managerA: "manager@acme.test", staffA: "staff@acme.test",
  ownerB: "owner@globex.test", outsider: "outsider@else.test", invitee: "invitee@else.test",
};

export type Q = <T = Record<string, any>>(sql: string, params?: readonly unknown[]) => Promise<T[]>;

const claims = (user: UserKey | null) =>
  user ? JSON.stringify({ sub: U[user], role: "authenticated", aud: "authenticated" }) : "{}";

async function run<T>(user: UserKey | null, role: string | null, commit: boolean, fn: (q: Q) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    if (role) await c.query(`set local role ${role}`);
    await c.query("select set_config('request.jwt.claims', $1, true)", [claims(user)]);
    // Each statement runs in its own savepoint, so an expected failure does not abort the test transaction.
    const q: Q = async (sql, params) => {
      await c.query("savepoint stmt");
      try {
        const rows = (await c.query(sql, params as unknown[])).rows;
        await c.query("release savepoint stmt");
        return rows;
      } catch (e) {
        await c.query("rollback to savepoint stmt");
        throw e;
      }
    };
    const out = await fn(q);
    await c.query(commit ? "commit" : "rollback");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export const as = <T>(user: UserKey | null, fn: (q: Q) => Promise<T>) =>
  run(user, user ? "authenticated" : "anon", false, fn);
export const asOwner = <T>(fn: (q: Q) => Promise<T>) => run(null, null, false, fn);
const commitAs = <T>(user: UserKey, fn: (q: Q) => Promise<T>) => run(user, "authenticated", true, fn);

/** Change identity inside an open test transaction (e.g. owner invites, then invitee accepts). */
export async function switchTo(q: Q, user: UserKey | "owner") {
  await q("reset role");
  if (user === "owner") return;
  await q("select set_config('request.jwt.claims', $1, true)", [claims(user)]);
  await q("set local role authenticated");
}

/** Postgres error message for a statement expected to fail. */
export async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("Expected the statement to fail, but it succeeded");
}

export const ids: { acme: string; globex: string; roles: Record<string, Record<string, string>> } = {
  acme: "", globex: "", roles: { acme: {}, globex: {} },
};

/** Idempotent, committed seed: two isolated workspaces with owner/manager/staff in Acme. */
export async function seed() {
  const existing = await asOwner((q) => q<{ id: string; slug: string }>("select id, slug from tenants"));
  if (existing.length === 0) {
    await asOwner(async () => undefined);
    const c = await pool.connect();
    try {
      for (const k of Object.keys(U) as UserKey[]) {
        await c.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [
          U[k], EMAIL[k], JSON.stringify({ full_name: k }),
        ]);
      }
    } finally {
      c.release();
    }
    await commitAs("ownerA", (q) => q("select create_workspace('Acme Distribution', 'acme')"));
    await commitAs("ownerB", (q) => q("select create_workspace('Globex Agency', 'globex')"));
  }
  const rows = await asOwner((q) => q<{ id: string; slug: string }>("select id, slug from tenants"));
  ids.acme = rows.find((r) => r.slug === "acme")!.id;
  ids.globex = rows.find((r) => r.slug === "globex")!.id;
  for (const [slug, tid] of [["acme", ids.acme], ["globex", ids.globex]] as const) {
    const rs = await asOwner((q) => q<{ id: string; key: string }>("select id, key from roles where tenant_id = $1", [tid]));
    for (const r of rs) ids.roles[slug]![r.key] = r.id;
  }
  const have = await asOwner((q) => q<{ n: number }>("select count(*)::int n from memberships where tenant_id = $1", [ids.acme]));
  if (have[0]!.n === 1) {
    for (const [who, role] of [["managerA", "manager"], ["staffA", "staff"]] as const) {
      const tok = await commitAs("ownerA", async (q) =>
        (await q<{ t: string }>("select invite_member($1, $2, $3) t", [ids.acme, EMAIL[who], ids.roles.acme![role]]))[0]!.t);
      await commitAs(who, (q) => q("select accept_invitation($1)", [tok]));
    }
  }
}
