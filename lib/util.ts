export const one = <T,>(x: T | T[] | null | undefined): T | null => (Array.isArray(x) ? (x[0] ?? null) : (x ?? null));

/** Escape LIKE wildcards in user search text. */
export const likeTerm = (q: string) => `%${q.trim().replace(/[\\%_,()]/g, " ")}%`;

export const inr = (n: number | string) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(n));

export const PAGE_SIZE = 50;
export const pageOf = (p: string | undefined) => Math.max(1, Number.parseInt(p ?? "1", 10) || 1);
