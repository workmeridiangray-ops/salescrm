import type { ReactNode } from "react";
import Link from "next/link";
import { can } from "@/lib/rules/permissions";
import { getWorkspace } from "@/lib/workspace";

export default async function WorkspaceLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { tenant, role, perms } = await getWorkspace(slug);
  const links = [
    { href: `/w/${slug}/today`, label: "Today", show: can(perms, "crm.write") },
    { href: `/w/${slug}/leads`, label: "Leads", show: can(perms, "crm.write") || can(perms, "crm.read_all") },
    { href: `/w/${slug}/accounts`, label: "Accounts", show: can(perms, "crm.write") || can(perms, "crm.read_all") },
    { href: `/w/${slug}/contacts`, label: "Contacts", show: can(perms, "crm.write") || can(perms, "crm.read_all") },
    { href: `/w/${slug}/pipeline`, label: "Pipeline", show: can(perms, "crm.write") || can(perms, "crm.read_all") },
    { href: `/w/${slug}/quotes`, label: "Quotes", show: can(perms, "crm.write") || can(perms, "crm.read_all") },
    { href: `/w/${slug}/products`, label: "Products", show: true },
    { href: `/w/${slug}/forecast`, label: "Forecast", show: can(perms, "crm.write") || can(perms, "crm.read_all") },
    { href: `/w/${slug}`, label: "Overview", show: true },
    { href: `/w/${slug}/members`, label: "Members", show: can(perms, "members.view") },
    { href: `/w/${slug}/roles`, label: "Roles", show: can(perms, "roles.manage") || can(perms, "members.view") },
    { href: `/w/${slug}/billing`, label: "Billing", show: can(perms, "billing.manage") },
    { href: `/w/${slug}/audit`, label: "Audit trail", show: can(perms, "audit.view") },
  ].filter((l) => l.show);
  return (
    <div className="mx-auto grid max-w-5xl gap-6 p-4 md:grid-cols-[200px_1fr]">
      <nav aria-label="Workspace" className="space-y-1">
        <div className="mb-3">
          <p className="font-semibold">{tenant.name}</p>
          <p className="text-sm text-muted">{role.name}{tenant.status === "trial" ? " · trial" : ""}</p>
          <Link href="/workspaces" className="text-sm text-accent underline">Switch workspace</Link>
        </div>
        {links.map((l) => <Link key={l.href} href={l.href} className="block rounded px-3 py-2 hover:bg-line/40">{l.label}</Link>)}
      </nav>
      <div>
        {tenant.status === "suspended" && (
          <p role="alert" className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
            This workspace is suspended (trial ended, payment lapsed, or paused by support). Data is kept but changes are blocked.
            {can(perms, "billing.manage") ? <> <Link className="underline" href={`/w/${slug}/billing`}>Open billing</Link></> : " Ask a workspace owner to resolve billing."}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}
