import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Get in touch", robots: { index: false } };

async function submit(form: FormData) {
  "use server";
  const slug = String(form.get("slug") ?? "");
  // Honeypot: real people never fill the hidden field.
  if (String(form.get("website") ?? "") !== "") redirect(`/capture/${slug}?sent=1`);
  const supabase = await createClient();
  const { error } = await supabase.rpc("capture_lead", {
    p_slug: slug, p_name: String(form.get("name") ?? ""), p_email: String(form.get("email") ?? ""),
    p_company: String(form.get("company") ?? ""), p_phone: String(form.get("phone") ?? ""), p_message: String(form.get("message") ?? ""),
  });
  redirect(`/capture/${slug}?${error ? "error=1" : "sent=1"}`);
}

export default async function Capture({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ sent?: string; error?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  void (await headers());
  return (
    <main className="mx-auto max-w-md p-6 pt-12">
      <h1 className="text-2xl font-semibold">Get in touch</h1>
      {sp.sent ? <p role="status" className="card mt-6">Thank you. We'll be in touch soon.</p> : (
        <form action={submit} className="card mt-6 space-y-3">
          {sp.error && <p role="alert" className="text-sm text-red-700">Please check your details and try again.</p>}
          <input type="hidden" name="slug" value={slug} />
          <div aria-hidden="true" className="hidden"><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
          <label className="block text-sm font-medium">Your name<input className="input mt-1" name="name" required maxLength={160} autoComplete="name" /></label>
          <label className="block text-sm font-medium">Email<input className="input mt-1" type="email" name="email" required autoComplete="email" /></label>
          <label className="block text-sm font-medium">Company<input className="input mt-1" name="company" autoComplete="organization" /></label>
          <label className="block text-sm font-medium">Phone<input className="input mt-1" name="phone" autoComplete="tel" /></label>
          <label className="block text-sm font-medium">How can we help?<textarea className="input mt-1 py-2" name="message" rows={4} maxLength={2000} /></label>
          <button className="btn w-full">Send</button>
        </form>
      )}
    </main>
  );
}
