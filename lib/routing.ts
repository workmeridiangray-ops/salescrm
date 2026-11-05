/** Paths a signed-out visitor may open. Everything else needs a session. */
const PUBLIC = ["/login"];
export const isPublicPath = (p: string) => PUBLIC.includes(p) || p === "/";

/** Only same-site relative paths may be used as a post-login destination. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/workspaces";
  return next;
}
