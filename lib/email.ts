import "server-only";

export type SendResult = { ok: boolean; messageId: string | null; error: string | null };
type Mail = { to: string; subject: string; html: string; text?: string; replyTo?: string; headers?: Record<string, string> };

/** Brevo transactional email with a result the caller can act on. Not configured => ok:false, error:"not_configured". */
export async function sendEmailDetailed(p: Mail): Promise<SendResult> {
  const key = process.env.BREVO_API_KEY;
  const from = process.env.EMAIL_FROM_ADDRESS;
  if (!key || !from) return { ok: false, messageId: null, error: "not_configured" };
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { email: from, name: process.env.EMAIL_FROM_NAME ?? "Sales CRM" },
        to: [{ email: p.to }], subject: p.subject, htmlContent: p.html, ...(p.text ? { textContent: p.text } : {}),
        ...(p.replyTo ? { replyTo: { email: p.replyTo } } : {}), ...(p.headers ? { headers: p.headers } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as { messageId?: string };
    return res.ok ? { ok: true, messageId: json.messageId ?? null, error: null } : { ok: false, messageId: null, error: `HTTP ${res.status}` };
  } catch {
    return { ok: false, messageId: null, error: "network error" };
  }
}

export async function sendEmail(p: Mail): Promise<boolean> {
  return (await sendEmailDetailed(p)).ok;
}
