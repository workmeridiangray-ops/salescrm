import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, SLUG_RE, SYSTEM_ROLES, can, friendlyError, holdsAll, isPermission, slugify } from "./permissions";

describe("permissions", () => {
  it("owner holds every permission; staff none; manager is a strict subset", () => {
    expect(SYSTEM_ROLES.owner.permissions).toEqual([...ALL_PERMISSIONS].sort());
    expect(SYSTEM_ROLES.staff.permissions).toEqual([]);
    expect(holdsAll(SYSTEM_ROLES.owner.permissions, SYSTEM_ROLES.manager.permissions)).toBe(true);
    expect(holdsAll(SYSTEM_ROLES.manager.permissions, SYSTEM_ROLES.owner.permissions)).toBe(false);
  });
  it("holdsAll of nothing is true; can checks one", () => {
    expect(holdsAll([], [])).toBe(true);
    expect(can(["audit.view"], "audit.view")).toBe(true);
    expect(can([], "audit.view")).toBe(false);
  });
  it("isPermission rejects inherited and unknown keys", () => {
    expect(isPermission("audit.view")).toBe(true);
    expect(isPermission("toString")).toBe(false);
    expect(isPermission("nope")).toBe(false);
  });
});

describe("slugify", () => {
  it.each([
    ["Acme Distribution", "acme-distribution"],
    ["  Ünïcode & Co.  ", "unicode-co"],
    ["A", "a"],
  ])("%s -> %s", (input, out) => expect(slugify(input)).toBe(out));
  it("never produces a trailing hyphen when truncated, and valid results match the DB pattern", () => {
    const s = slugify("x".repeat(39) + " tail");
    expect(s.endsWith("-")).toBe(false);
    expect(SLUG_RE.test(s)).toBe(true);
  });
});

describe("friendlyError", () => {
  it("maps known codes and hides unknown database text", () => {
    expect(friendlyError("last_owner")).toMatch(/at least one/);
    expect(friendlyError('relation "x" does not exist')).toBe("Something went wrong. Please try again.");
    expect(friendlyError(undefined)).toMatch(/Something went wrong/);
  });
});
