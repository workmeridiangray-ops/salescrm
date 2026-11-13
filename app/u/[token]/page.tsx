import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Unsubscribe", robots: { index: false, follow: false } };

async function unsubscribe(token: string) {
  "use server";
  await (await createClient()).rpc("unsubscribe", { p_token: token });
}

export default async function Unsubscribe({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string }> }) {
  const { token } = await params;
  const { done } = await searchParams;
  async function confirm() {
    "use server";
    await unsubscribe(token);
    const { redirect } = await import("next/navigation");
    redirect(`/u/${encodeURIComponent(token)}?done=1`);
  }
  return (
    <main className="mx-auto max-w-md p-8">
      {done ? (<><h1 className="text-xl font-semibold">You're unsubscribed</h1><p className="mt-2 text-muted">You won't get any more outreach emails from this sender. It can take a few minutes to take effect everywhere.</p></>)
        : (<><h1 className="text-xl font-semibold">Unsubscribe from these emails?</h1><p className="mt-2 text-muted">Press the button to stop all outreach emails to this address.</p>
          <form action={confirm} className="mt-4"><button className="btn">Yes, unsubscribe me</button></form></>)}
    </main>
  );
}
