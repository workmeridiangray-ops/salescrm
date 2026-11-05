import type { ReactNode } from "react";
import Link from "next/link";

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link href="/" className="font-semibold">Sales CRM</Link>
          <nav aria-label="Main" className="flex flex-wrap items-center gap-4 text-sm">
            <Link href="/features">Features</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/demo">Book a demo</Link>
            <Link href="/login" className="btn-quiet">Sign in</Link>
            <Link href="/login?mode=signup" className="btn">Start free trial</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10">{children}</main>
      <footer className="border-t border-line bg-surface py-6 text-center text-sm text-muted">
        © {new Date().getFullYear()} Sales CRM · <Link href="/pricing">Pricing</Link> · <Link href="/demo">Contact</Link>
      </footer>
    </div>
  );
}
