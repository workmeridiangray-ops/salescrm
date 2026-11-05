import Link from "next/link";

export default function AccessDenied() {
  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-xl font-semibold">You don't have access to that workspace</h1>
      <p className="mt-2 text-muted">Ask a workspace owner to invite you, or switch to a workspace you belong to.</p>
      <Link className="btn mt-4" href="/workspaces">Your workspaces</Link>
    </main>
  );
}
