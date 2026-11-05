import { beforeAll, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, SYSTEM_ROLES } from "@/lib/rules/permissions";
import { asOwner, ids, seed } from "./helpers";

beforeAll(seed);

describe("TypeScript rules match the database", () => {
  it("permission catalogue is identical", async () => {
    const rows = await asOwner((q) => q<{ key: string }>("select key from permissions order by key"));
    expect(rows.map((r) => r.key)).toEqual([...ALL_PERMISSIONS].sort());
  });
  it("system roles carry the same permissions", async () => {
    const rows = await asOwner((q) => q<{ key: string; permissions: string[] }>("select key, permissions from roles where tenant_id = $1", [ids.acme]));
    for (const r of rows) {
      const ts = SYSTEM_ROLES[r.key as keyof typeof SYSTEM_ROLES];
      expect(ts, r.key).toBeDefined();
      expect([...r.permissions].sort()).toEqual([...ts.permissions].sort());
    }
    expect(rows).toHaveLength(3);
  });
});
