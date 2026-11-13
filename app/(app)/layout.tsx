import type { ReactNode } from "react";
import { signOut } from "../(auth)/actions";
import { currentUser } from "@/lib/workspace";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  return (
    <div>
      <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-2 text-sm">
        <a href="/workspaces" className="font-semibold">Sales CRM</a>
        <form action={signOut} className="flex items-center gap-3">
          <a href="/security" className="text-muted underline">{user.email}</a>
          <button className="btn-quiet">Sign out</button>
        </form>
      </header>
      {children}
    </div>
  );
}
