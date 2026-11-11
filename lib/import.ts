import { parseCsv } from "./csv";

export type ImportEntity = "accounts" | "contacts" | "leads";
export const MAX_ROWS = 2000;
export const MAX_BYTES = 1_000_000;

/** Header name (lower-case) -> canonical field. */
export const COLUMNS: Record<ImportEntity, { required: string[]; fields: Record<string, string> }> = {
  accounts: { required: ["name"], fields: { name: "name", company: "name", domain: "domain", website: "domain", industry: "industry" } },
  contacts: { required: ["name"], fields: { name: "name", "full name": "name", email: "email", phone: "phone", title: "title", "job title": "title", account: "account", company: "account" } },
  leads: { required: ["name"], fields: { name: "name", email: "email", company: "company", phone: "phone", message: "message", notes: "message" } },
};
export const TEMPLATE: Record<ImportEntity, string[]> = {
  accounts: ["name", "domain", "industry"],
  contacts: ["name", "email", "phone", "title", "account"],
  leads: ["name", "email", "company", "phone", "message"],
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIMITS: Record<string, number> = { name: 160, email: 200, phone: 40, title: 120, account: 160, company: 160, domain: 200, industry: 120, message: 2000 };

export type ParsedRow = { _line: number; [k: string]: string | number };
export type Problem = { row: number; error: string };
export type Validated = { rows: ParsedRow[]; problems: Problem[]; total: number; fatal?: string };

/** Parse and check a CSV before it touches the database. Line numbers are spreadsheet rows (header = 1). */
export function validateImport(entity: ImportEntity, text: string): Validated {
  const fail = (fatal: string): Validated => ({ rows: [], problems: [], total: 0, fatal });
  if (text.length > MAX_BYTES) return fail("File is too large (limit 1 MB).");
  let table: string[][];
  try { table = parseCsv(text); } catch { return fail("The file has an unclosed quote. Check the CSV."); }
  if (table.length < 2) return fail("The file needs a header row and at least one data row.");
  if (table.length - 1 > MAX_ROWS) return fail(`Imports are limited to ${MAX_ROWS} rows. Split the file.`);

  const spec = COLUMNS[entity];
  const map = table[0]!.map((h) => spec.fields[h.trim().toLowerCase()] ?? null);
  for (const req of spec.required) if (!map.includes(req)) return fail(`Missing a "${req}" column. Expected: ${TEMPLATE[entity].join(", ")}.`);

  const rows: ParsedRow[] = [], problems: Problem[] = [];
  const seen = new Set<string>();
  table.slice(1).forEach((cells, idx) => {
    const line = idx + 2;
    const r: ParsedRow = { _line: line };
    map.forEach((field, i) => { if (field && r[field] === undefined) r[field] = (cells[i] ?? "").trim(); });
    const bad = (error: string) => problems.push({ row: line, error });
    if (!r.name) return bad("Name is empty.");
    for (const [k, v] of Object.entries(r)) if (k !== "_line" && String(v).length > (LIMITS[k] ?? 200)) return bad(`${k} is too long.`);
    if (r.email && !EMAIL.test(String(r.email))) return bad(`"${r.email}" isn't a valid email address.`);
    const key = entity === "accounts" ? String(r.name).toLowerCase() : r.email ? String(r.email).toLowerCase() : "";
    if (key) {
      if (seen.has(key)) return bad(`Duplicate of an earlier row in this file (${key}).`);
      seen.add(key);
    }
    rows.push(r);
  });
  return { rows, problems, total: table.length - 1 };
}

/** Turn database error text into something a person can act on. */
export function importError(msg: string): string {
  if (/accounts_name_unique/.test(msg)) return "An account with this name already exists.";
  if (/contacts_email_unique|leads_email_open/.test(msg)) return "A record with this email already exists.";
  if (/account_not_found/.test(msg)) return "No account with that name. Import accounts first.";
  if (/row-level security|forbidden/.test(msg)) return "You don't have permission to add this record.";
  return "This row couldn't be imported.";
}
