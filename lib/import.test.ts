import { describe, expect, it } from "vitest";
import { importError, validateImport } from "./import";

describe("validateImport", () => {
  it("accepts a good file, maps header aliases and reports spreadsheet line numbers", () => {
    const v = validateImport("contacts", "Full Name,Email,Job Title,Company\nAsha Rao,ASHA@x.test,CTO,Acme\nBad,not-an-email,,\n");
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0]).toMatchObject({ _line: 2, name: "Asha Rao", email: "ASHA@x.test", title: "CTO", account: "Acme" });
    expect(v.problems).toEqual([{ row: 3, error: '"not-an-email" isn\'t a valid email address.' }]);
  });
  it("flags empty names, duplicates inside the file and overlong values", () => {
    const v = validateImport("leads", `name,email\n,a@x.test\nA,a@x.test\nB,A@X.TEST\n${"C".repeat(161)},c@x.test\n`);
    expect(v.rows.map((r) => r._line)).toEqual([3]);
    expect(v.problems.map((p) => p.row)).toEqual([2, 4, 5]);
  });
  it("duplicates for accounts are by name, case-insensitive", () => {
    const v = validateImport("accounts", "name\nAcme\nacme\n");
    expect(v.rows).toHaveLength(1);
    expect(v.problems[0]!.error).toMatch(/Duplicate/);
  });
  it("rejects unusable files with a clear message", () => {
    expect(validateImport("accounts", "").fatal).toMatch(/header row/);
    expect(validateImport("accounts", "domain\nx.com\n").fatal).toMatch(/"name" column/);
    expect(validateImport("accounts", 'name\n"oops').fatal).toMatch(/quote/);
    expect(validateImport("accounts", "name\n" + "a\n".repeat(2001)).fatal).toMatch(/2000/);
  });
  it("maps database errors to plain language", () => {
    expect(importError('duplicate key value violates unique constraint "accounts_name_unique"')).toMatch(/already exists/);
    expect(importError("something internal blew up: table x")).toBe("This row couldn't be imported.");
  });
});
