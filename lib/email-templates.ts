export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function invitationEmail(p: { workspace: string; inviter: string; link: string }) {
  const w = escapeHtml(p.workspace), i = escapeHtml(p.inviter), l = escapeHtml(p.link);
  return {
    subject: `${p.inviter} invited you to ${p.workspace} on Sales CRM`.replace(/[\r\n]+/g, " "),
    html: `<p>${i} invited you to join <strong>${w}</strong> on Sales CRM.</p><p><a href="${l}">Accept the invitation</a></p><p>The link works for 7 days and only for this email address. If you weren't expecting it, ignore this message.</p>`,
  };
}
