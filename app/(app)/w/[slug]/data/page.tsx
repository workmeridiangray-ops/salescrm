import type { Metadata } from "next";
import { can } from "@/lib/rules/permissions";
import { TEMPLATE } from "@/lib/import";
import { getWorkspace } from "@/lib/workspace";
import { Hidden, Notice } from "@/components/ui";
import { runImport } from "./actions";

export const metadata: Metadata = { title: "Import and export" };

export default async function Data({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { perms } = await getWorkspace(slug);
  let problems: { row: number; error: string }[] = [];
  try { problems = sp.problems ? JSON.parse(sp.problems) : []; } catch { problems = []; }
  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">Import and export</h1>
      <Notice error={sp.error} />
      {sp.imported !== undefined && (
        <div role="status" className="card space-y-2">
          <p><strong>{sp.imported}</strong> {sp.entity} imported{Number(sp.skipped) > 0 && <>, <strong>{sp.skipped}</strong> skipped</>}.</p>
          {problems.length > 0 && (<><p className="text-sm text-muted">Fix these rows in your file and import just them again; rows already imported are never duplicated.</p>
            <ul className="list-disc pl-5 text-sm">{problems.map((p, i) => <li key={i}>Row {p.row}: {p.error}</li>)}</ul></>)}
        </div>)}
      {can(perms, "crm.write") && (
        <form action={runImport} className="card space-y-3"><Hidden name="slug" value={slug} />
          <h2 className="font-semibold">Import from CSV</h2>
          <label className="block text-sm font-medium">What are you importing?
            <select name="entity" className="input mt-1 max-w-xs"><option value="accounts">Accounts</option><option value="contacts">Contacts</option><option value="leads">Leads</option></select></label>
          <p className="text-sm text-muted">Columns — accounts: {TEMPLATE.accounts.join(", ")}. Contacts: {TEMPLATE.contacts.join(", ")} (account must already exist). Leads: {TEMPLATE.leads.join(", ")}. Up to 2,000 rows and 1 MB. Imported records are owned by you.</p>
          <label className="block text-sm font-medium">CSV file<input className="input mt-1 py-2" type="file" name="file" accept=".csv,text/csv" /></label>
          <label className="block text-sm font-medium">…or paste CSV<textarea className="input mt-1 py-2 font-mono text-xs" name="csv" rows={6} placeholder={"name,domain,industry\nAcme Ltd,acme.example,Manufacturing"} /></label>
          <button className="btn">Import</button>
        </form>)}
      {can(perms, "crm.export") ? (
        <div className="card space-y-2"><h2 className="font-semibold">Export to CSV</h2>
          <p className="text-sm text-muted">You get the records you can see. Every export is recorded in the audit trail.</p>
          <div className="flex flex-wrap gap-2">{["accounts", "contacts", "leads", "opportunities"].map((e) => <a key={e} className="btn-quiet" href={`/w/${slug}/data/export/${e}`}>{e[0]!.toUpperCase() + e.slice(1)}</a>)}</div></div>
      ) : <p className="text-sm text-muted">Exporting is limited to roles with export permission.</p>}
    </section>
  );
}
