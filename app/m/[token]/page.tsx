import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Your booking", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type View = { title: string; starts_at: string; ends_at: string; status: string; tz: string; slug: string; company: string; can_cancel: boolean };

export default async function Manage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ new?: string; cancelled?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
  const { data } = await (await createClient()).rpc("meeting_for_token", { p_token: token });
  const v = data as View | null;
  async function cancel() {
    "use server";
    await (await createClient()).rpc("cancel_meeting_by_token", { p_token: token });
    redirect(`/m/${encodeURIComponent(token)}?cancelled=1`);
  }
  if (!v) return <main className="mx-auto max-w-md p-8"><h1 className="text-xl font-semibold">Booking not found</h1><p className="mt-2 text-muted">Check the link in your confirmation email.</p></main>;
  const when = new Date(v.starts_at).toLocaleString("en-IN", { timeZone: v.tz, dateStyle: "full", timeStyle: "short" });
  return (
    <main className="mx-auto max-w-md space-y-4 p-8">
      {sp.new && <p role="status" className="card">Booked. {process.env.BREVO_API_KEY ? "A confirmation is on its way to your inbox." : "Save this page's link to change or cancel later."}</p>}
      <h1 className="text-xl font-semibold">{v.title}</h1>
      <p className="text-muted">{v.company}<br />{when} ({v.tz})</p>
      <p>Status: <strong>{v.status === "scheduled" ? "Confirmed" : v.status.replace("_", " ")}</strong></p>
      {v.can_cancel ? (<div className="flex flex-wrap gap-3"><form action={cancel}><button className="btn-quiet">Cancel booking</button></form><a className="btn-quiet" href={`/book/${v.slug}`}>Book a different time</a></div>)
        : v.status === "cancelled" ? <a className="btn" href={`/book/${v.slug}`}>Book another time</a> : null}
      {sp.cancelled && <p role="status" className="text-sm">Your booking was cancelled. To pick a new time, use "Book another time". Please cancel the old one first if you haven't.</p>}
    </main>
  );
}
