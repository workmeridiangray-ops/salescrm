import "server-only";

/** Brevo transactional email. Returns false when email isn't configured, so callers can fall back. */
export async function sendEmail(p: { to: string; subject: string; html: string }): Promise<boolean> {
  const key = process.env.BREVO_API_KEY;
  const from = process.env.EMAIL_FROM_ADDRESS;
  if (!key || !from) return false;
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { email: from, name: process.env.EMAIL_FROM_NAME ?? "Sales CRM" },
      to: [{ email: p.to }], subject: p.subject, htmlContent: p.html,
    }),
  });
  return res.ok;
}
