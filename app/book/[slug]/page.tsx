import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { sendEmail } from "@/lib/email";
import { escapeHtml } from "@/lib/email-templates";
import { friendlyError } from "@/lib/rules/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Book a time", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type View = { title: string; duration_min: number; tz: string; company: string; host: string; slots: string[] };

async function book(form: FormData) {
  "use server";
  const slug = String(form.get("slug") ?? ""), at = String(form.get("at") ?? "");
  const { data, error } = await (await createClient()).rpc("book_slot", {
    p_slug: slug, p_starts: at, p_name: String(form.get("name") ?? ""), p_email: String(form.get("email") ?? ""), p_notes: String(form.get("notes") ?? ""),
  });
  if (error) redirect(`/book/${slug}?error=${encodeURIComponent(friendlyError(error.message))}`);
  const r = data as { token: string; starts_at: string; tz: string; title: string; company: string; owner_email: string | null };
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const when = new Date(r.starts_at).toLocaleString("en-IN", { timeZone: r.tz, dateStyle: "full", timeStyle: "short" });
  await sendEmail({
    to: String(form.get("email") ?? "").trim().toLowerCase(), subject: `Confirmed: ${r.title} with ${r.company}`.replace(/[\r\n]+/g, " "),
    html: `<p>Your booking with <strong>${escapeHtml(r.company)}</strong> is confirmed.</p><p>${escapeHtml(r.title)}<br>${escapeHtml(when)} (${escapeHtml(r.tz)})</p><p><a href="${escapeHtml(`${base}/m/${r.token}`)}">View or cancel your booking</a></p>`,
    replyTo: r.owner_email ?? undefined,
  });
  redirect(`/m/${r.token}?new=1`);
}

export default async function Book({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ day?: string; at?: string; error?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { data } = await (await createClient()).rpc("booking_slots", { p_slug: slug, p_days: 30 });
  const v = data as View | null;
  if (!v) return <main className="mx-auto max-w-md p-8"><h1 className="text-xl font-semibold">This booking page isn't available</h1><p className="mt-2 text-muted">The link may be wrong or the page may have been turned off.</p></main>;
  const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: v.tz });   // YYYY-MM-DD in the host's zone
  const days = [...new Set(v.slots.map(dayOf))];
  const day = sp.day && days.includes(sp.day) ? sp.day : days[0];
  const daySlots = v.slots.filter((s) => dayOf(s) === day);
  const chosen = sp.at && v.slots.includes(sp.at) ? sp.at : null;
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { timeZone: v.tz, hour: "2-digit", minute: "2-digit" });
  return (
    <main className="mx-auto max-w-2xl space-y-5 p-6">
      <header><p className="text-sm text-muted">{v.company}</p><h1 className="text-2xl font-semibold">{v.title}</h1><p className="text-sm text-muted">with {v.host} · {v.duration_min} minutes · times in {v.tz}</p></header>
      {sp.error && <p role="alert" className="rounded border border-line bg-surface p-3 text-sm text-red-700">{sp.error}</p>}
      {days.length === 0 ? <p className="card">No times are available right now. Please check back later.</p> : (<>
        <nav aria-label="Days" className="flex flex-wrap gap-2">{days.map((d) => <a key={d} href={`?day=${d}`} aria-current={d === day ? "date" : undefined}
          className={`rounded px-3 py-1.5 text-sm ${d === day ? "bg-accent text-white" : "border border-line bg-surface"}`}>{new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}</a>)}</nav>
        <ul className="flex flex-wrap gap-2" aria-label="Available times">{daySlots.map((s) => <li key={s}><a href={`?day=${day}&at=${encodeURIComponent(s)}`} aria-current={s === chosen ? "true" : undefined}
          className={`inline-flex min-h-[40px] items-center rounded border px-3 text-sm ${s === chosen ? "border-accent bg-accent text-white" : "border-line bg-surface"}`}>{time(s)}</a></li>)}</ul>
        {chosen && (
          <form action={book} className="card space-y-3"><input type="hidden" name="slug" value={slug} /><input type="hidden" name="at" value={chosen} />
            <p className="text-sm font-medium">{new Date(chosen).toLocaleString("en-IN", { timeZone: v.tz, dateStyle: "full", timeStyle: "short" })}</p>
            <label className="block text-sm font-medium">Your name<input className="input mt-1" name="name" required maxLength={160} autoComplete="name" /></label>
            <label className="block text-sm font-medium">Email<input className="input mt-1" type="email" name="email" required autoComplete="email" /></label>
            <label className="block text-sm font-medium">Anything we should know? (optional)<textarea className="input mt-1 py-2" name="notes" rows={3} maxLength={1000} /></label>
            <button className="btn w-full">Confirm booking</button></form>)}</>)}
    </main>
  );
}
