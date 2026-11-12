/** Paths a signed-out visitor may open. Everything else needs a session. */
const PUBLIC = ["/login", "/features", "/pricing", "/demo"];
export const isPublicPath = (p: string) => PUBLIC.includes(p) || p === "/" || p.startsWith("/capture/") || p.startsWith("/quote/") || p.startsWith("/api/razorpay/") || p.startsWith("/api/v1/") || p.startsWith("/api/webhooks/");

/** Only same-site relative paths may be used as a post-login destination. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/workspaces";
  return next;
}
