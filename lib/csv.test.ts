import { describe, expect, it } from "vitest";
import { parseCsv, sanitizeCell, toCsv } from "./csv";

describe("parseCsv", () => {
  it("handles quotes, embedded commas/newlines, escaped quotes, CRLF and BOM", () => {
    expect(parseCsv('﻿name,note\r\n"Doe, Jo","say ""hi""\nbye"\r\nPat,\r\n')).toEqual([["name", "note"], ["Doe, Jo", 'say "hi"\nbye'], ["Pat", ""]]);
  });
  it("skips blank lines, keeps empty cells, accepts a file without a trailing newline", () => {
    expect(parseCsv("a,b\n\n1,\n,2")).toEqual([["a", "b"], ["1", ""], ["", "2"]]);
  });
  it("rejects an unterminated quote", () => expect(() => parseCsv('a\n"oops')).toThrow("unterminated_quote"));
  it("empty input has no rows", () => expect(parseCsv("")).toEqual([]));
});

describe("toCsv", () => {
  it("round-trips awkward values", () => {
    const rows = [["a", 'b"c', "d,e", "f\ng"], ["", "1", "2", "3"]];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
  it("neutralises formula injection", () => {
    for (const bad of ["=1+1", "+cmd", "-2", "@SUM(A1)", "\tx"]) expect(sanitizeCell(bad).startsWith("'")).toBe(true);
    expect(sanitizeCell("normal")).toBe("normal");
    expect(toCsv([["=HYPERLINK(\"x\")"]])).toContain("'=HYPERLINK");
  });
});
