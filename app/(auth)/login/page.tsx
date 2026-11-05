import type { Metadata } from "next";
import { signIn, signUp } from "../actions";

export const metadata: Metadata = { title: "Sign in" };

const MESSAGES: Record<string, string> = {
  credentials: "That email and password don't match.",
  signup: "We couldn't create that account. Use a valid email and a password of at least 8 characters.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const signup = sp.mode === "signup";
  return (
    <main className="mx-auto max-w-sm p-6 pt-16">
      <h1 className="text-2xl font-semibold">{signup ? "Create your account" : "Sign in"}</h1>
      {sp.error && <p role="alert" className="mt-4 rounded border border-line bg-surface p-3 text-sm text-red-700">{MESSAGES[sp.error] ?? "Something went wrong."}</p>}
      {sp.notice === "confirm" && <p role="status" className="mt-4 rounded border border-line bg-surface p-3 text-sm">Check your email to confirm your address, then sign in.</p>}
      <form action={signup ? signUp : signIn} className="card mt-6 space-y-4">
        <input type="hidden" name="next" value={sp.next ?? ""} />
        {signup && (
          <label className="block text-sm font-medium">Full name
            <input className="input mt-1" name="full_name" autoComplete="name" required />
          </label>
        )}
        <label className="block text-sm font-medium">Email
          <input className="input mt-1" type="email" name="email" autoComplete="email" required />
        </label>
        <label className="block text-sm font-medium">Password
          <input className="input mt-1" type="password" name="password" autoComplete={signup ? "new-password" : "current-password"} minLength={8} required />
        </label>
        <button className="btn w-full">{signup ? "Create account" : "Sign in"}</button>
      </form>
      <p className="mt-4 text-sm text-muted">
        {signup ? "Already have an account? " : "New here? "}
        <a className="text-accent underline" href={`/login${signup ? "" : "?mode=signup"}${sp.next ? `${signup ? "?" : "&"}next=${encodeURIComponent(sp.next)}` : ""}`}>
          {signup ? "Sign in" : "Create an account"}
        </a>
      </p>
    </main>
  );
}
