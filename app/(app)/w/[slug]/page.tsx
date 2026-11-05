import { getWorkspace } from "@/lib/workspace";

export default async function Overview({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { tenant, role } = await getWorkspace(slug);
  return (
    <section>
      <h1 className="text-2xl font-semibold">{tenant.name}</h1>
      <p className="mt-1 text-muted">You are signed in as {role.name}. Accounts, leads and pipelines arrive in the next phases.</p>
    </section>
  );
}
