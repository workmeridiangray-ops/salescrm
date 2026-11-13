import { escapeHtml } from "./email-templates";

/** Sequence bodies are plain text. Convert safely to HTML and add the mandatory unsubscribe footer. */
export function buildOutreach(body: string, unsubUrl: string, senderName?: string, oneClickUrl: string = unsubUrl) {
  const paragraphs = body.replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
  const footer = `<hr><p style="font-size:12px;color:#526174">${senderName ? `Sent by ${escapeHtml(senderName)}. ` : ""}Don't want these emails? <a href="${escapeHtml(unsubUrl)}">Unsubscribe</a>.</p>`;
  const text = `${body}\n\n--\nDon't want these emails? Unsubscribe: ${unsubUrl}`;
  return {
    html: paragraphs + footer,
    text,
    // RFC 8058 one-click unsubscribe so mail clients show their own button
    headers: { "List-Unsubscribe": `<${oneClickUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } as Record<string, string>,
  };
}

export const unsubscribeUrl = (base: string, token: string) => `${base.replace(/\/$/, "")}/u/${token}`;
export const oneClickUrl = (base: string, token: string) => `${base.replace(/\/$/, "")}/api/unsubscribe/${token}`;
