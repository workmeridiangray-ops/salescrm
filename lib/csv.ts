/** Minimal RFC 4180 CSV parsing and writing, with spreadsheet-formula protection on output. */

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let sawAny = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === "") { quoted = true; sawAny = true; }
    else if (c === ",") { row.push(cell); cell = ""; sawAny = true; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (sawAny || cell !== "") { row.push(cell); rows.push(row); }
      row = []; cell = ""; sawAny = false;
    } else { cell += c; sawAny = true; }
  }
  if (quoted) throw new Error("unterminated_quote");
  if (sawAny || cell !== "") { row.push(cell); rows.push(row); }
  return rows;
}

/** Cells starting with = + - @ tab or CR can run as formulas when opened in a spreadsheet. */
export function sanitizeCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function toCsv(rows: unknown[][]): string {
  const esc = (v: unknown) => {
    const s = sanitizeCell(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}
