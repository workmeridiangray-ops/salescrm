import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Book a demo" };

async function submit(form: FormData) {
  "use server";
  if (String(form.get("website") ?? "") !== "") redirect("/demo?sent=1"); // honeypot
  const supabase = await createClient();
  const { error } = await supabase.rpc("submit_demo_request", {
    p_name: String(form.get("name") ?? ""), p_email: String(form.get("email") ?? ""),
    p_company: String(form.get("company") ?? ""), p_message: String(form.get("message") ?? ""),
  });
  redirect(`/demo?${error ? "error=1" : "sent=1"}`);
}

export default async function Demo({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-3xl font-semibold">Book a demo</h1>
      <p className="mt-1 text-muted">Tell us a little about your team and we'll get back to you.</p>
      {sp.sent ? <p role="status" className="card mt-6">Thank you. We'll be in touch.</p> : (
        <form action={submit} className="card mt-6 space-y-3">
          {sp.error && <p role="alert" className="text-sm text-red-700">Please check your details and try again.</p>}
          <div aria-hidden="true" className="hidden"><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
          <label className="block text-sm font-medium">Your name<input className="input mt-1" name="name" required maxLength={160} autoComplete="name" /></label>
          <label className="block text-sm font-medium">Work email<input className="input mt-1" type="email" name="email" required autoComplete="email" /></label>
          <label className="block text-sm font-medium">Company<input className="input mt-1" name="company" autoComplete="organization" /></label>
          <label className="block text-sm font-medium">What would you like to see?<textarea className="input mt-1 py-2" name="message" rows={4} maxLength={2000} /></label>
          <button className="btn w-full">Request demo</button>
        </form>
      )}
    </div>
  );
}
