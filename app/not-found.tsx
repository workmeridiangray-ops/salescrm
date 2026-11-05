import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="mt-2 text-muted">It may not exist, or you may not have access to it.</p>
      <Link className="btn mt-4" href="/workspaces">Back to workspaces</Link>
    </main>
  );
}
