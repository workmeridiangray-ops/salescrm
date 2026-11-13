import type { Metadata } from "next";
import { MfaManager } from "@/components/mfa-enroll";
import { createClient } from "@/lib/supabase/server";
import { currentUser } from "@/lib/workspace";

export const metadata: Metadata = { title: "Security" };

export default async function Security() {
  await currentUser();
  const { data } = await (await createClient()).auth.mfa.listFactors();
  const factors = [...(data?.totp ?? []), ...(data?.all?.filter((f) => f.factor_type !== "totp") ?? [])].map((f) => ({ id: f.id, friendly_name: f.friendly_name, status: f.status }));
  return (
    <main className="mx-auto max-w-lg space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Security</h1>
      <h2 className="font-semibold">Two-step sign-in</h2>
      <p className="text-sm text-muted">After you turn this on, signing in also needs a 6-digit code from your authenticator app. Keep your app safe: if you lose it, a workspace owner or the vendor must reset it for you.</p>
      <MfaManager factors={factors} />
    </main>
  );
}
