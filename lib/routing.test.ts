import { describe, expect, it } from "vitest";
import { isPublicPath, safeNext } from "./routing";

describe("safeNext", () => {
  it.each([
    ["/w/acme/members?x=1", "/w/acme/members?x=1"],
    ["//evil.test", "/workspaces"],
    ["https://evil.test", "/workspaces"],
    ["/\\evil.test", "/workspaces"],
    [null, "/workspaces"],
  ])("%s", (i, o) => expect(safeNext(i)).toBe(o));
});
describe("isPublicPath", () => {
  it("only the landing and login are public", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/w/acme")).toBe(false);
    expect(isPublicPath("/invite/abc")).toBe(false);
  });
});
