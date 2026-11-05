import type { ReactNode } from "react";

export const Hidden = ({ name, value }: { name: string; value: string }) => <input type="hidden" name={name} value={value} />;

export function Notice({ error, ok }: { error?: string; ok?: string }) {
  if (error) return <p role="alert" className="rounded border border-line bg-surface p-3 text-sm text-red-700">{error}</p>;
  if (ok) return <p role="status" className="rounded border border-line bg-surface p-3 text-sm text-green-800">{ok}</p>;
  return null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="card text-center text-muted">{children}</div>;
}

export function Pager({ base, page, more }: { base: string; page: number; more: boolean }) {
  const sep = base.includes("?") ? "&" : "?";
  return (
    <nav aria-label="Pages" className="flex items-center justify-between text-sm">
      {page > 1 ? <a className="btn-quiet" href={`${base}${sep}page=${page - 1}`}>Previous</a> : <span />}
      <span className="text-muted">Page {page}</span>
      {more ? <a className="btn-quiet" href={`${base}${sep}page=${page + 1}`}>Next</a> : <span />}
    </nav>
  );
}

export const Badge = ({ children, tone = "grey" }: { children: ReactNode; tone?: "grey" | "green" | "red" | "blue" | "amber" }) => {
  const tones = { grey: "bg-line/50 text-ink", green: "bg-green-100 text-green-900", red: "bg-red-100 text-red-900", blue: "bg-blue-100 text-blue-900", amber: "bg-amber-100 text-amber-900" };
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
};
