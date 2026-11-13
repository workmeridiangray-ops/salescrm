import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MfaChallenge } from "@/components/mfa-enroll";
import { safeNext } from "@/lib/routing";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Verify it's you" };

export default async function Mfa({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const dest = safeNext(next);
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === "aal2" || aal?.nextLevel !== "aal2") redirect(dest);
  const { data: f } = await supabase.auth.mfa.listFactors();
  const factor = f?.totp?.[0];
  if (!factor) redirect(dest);
  return (
    <main className="mx-auto max-w-sm p-6 pt-16">
      <h1 className="text-2xl font-semibold">Enter your code</h1>
      <p className="mt-1 text-muted">Open your authenticator app and enter the 6-digit code for Sales CRM.</p>
      <MfaChallenge factorId={factor.id} next={dest} />
    </main>
  );
}
