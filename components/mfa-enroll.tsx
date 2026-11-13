"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/browser";

type Factor = { id: string; friendly_name?: string | null; status: string };

export function MfaManager({ factors }: { factors: Factor[] }) {
  const router = useRouter();
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const verified = factors.filter((f) => f.status === "verified");

  async function start() {
    setBusy(true); setMsg(null);
    const { data, error } = await createBrowserSupabase().auth.mfa.enroll({ factorType: "totp", friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}` });
    setBusy(false);
    if (error || !data) return setMsg("We couldn't start setup. Try again.");
    setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }
  async function confirm(e: React.FormEvent) {
    e.preventDefault(); if (!enroll) return;
    setBusy(true); setMsg(null);
    const { error } = await createBrowserSupabase().auth.mfa.challengeAndVerify({ factorId: enroll.id, code: code.trim() });
    setBusy(false);
    if (error) return setMsg("That code didn't match. Check your authenticator app and try again.");
    setEnroll(null); setCode(""); router.refresh();
  }
  async function remove(id: string) {
    setBusy(true); setMsg(null);
    const { error } = await createBrowserSupabase().auth.mfa.unenroll({ factorId: id });
    setBusy(false);
    if (error) return setMsg("Couldn't remove it. You must be signed in with your authenticator code first.");
    router.refresh();
  }
  return (
    <div className="space-y-4">
      {msg && <p role="alert" className="rounded border border-line bg-surface p-3 text-sm text-red-700">{msg}</p>}
      {verified.length > 0 && (
        <ul className="space-y-2">{verified.map((f) => (
          <li key={f.id} className="card flex items-center justify-between text-sm"><span>{f.friendly_name || "Authenticator app"} <span className="text-green-800">· on</span></span>
            <button className="btn-quiet" disabled={busy} onClick={() => remove(f.id)}>Remove</button></li>))}</ul>)}
      {!enroll && verified.length === 0 && <button className="btn" disabled={busy} onClick={start}>Set up authenticator app</button>}
      {enroll && (
        <form onSubmit={confirm} className="card space-y-3">
          <p className="text-sm">Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), then enter the 6-digit code.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={enroll.qr} alt="QR code for your authenticator app" width={180} height={180} />
          <p className="text-xs text-muted">Can't scan? Enter this key instead: <code className="break-all">{enroll.secret}</code></p>
          <label className="block text-sm font-medium">6-digit code<input className="input mt-1 w-40" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} /></label>
          <button className="btn" disabled={busy}>Turn on</button>
        </form>)}
    </div>
  );
}

export function MfaChallenge({ factorId, next }: { factorId: string; next: string }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    const { error } = await createBrowserSupabase().auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    setBusy(false);
    if (error) return setMsg("That code didn't match. Try the newest code.");
    router.replace(next); router.refresh();
  }
  return (
    <form onSubmit={submit} className="card mt-6 space-y-3">
      {msg && <p role="alert" className="text-sm text-red-700">{msg}</p>}
      <label className="block text-sm font-medium">6-digit code<input className="input mt-1" inputMode="numeric" autoComplete="one-time-code" autoFocus pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} /></label>
      <button className="btn w-full" disabled={busy}>Verify</button>
    </form>
  );
}
