import { safeNext } from "./routing";

/**
 * If the person has an authenticator enrolled (nextLevel aal2) but this session
 * has only passed the password step (currentLevel aal1), send them to /mfa.
 * Returns the redirect target, or null to let the request through.
 */
export function mfaRedirect(current: string | null | undefined, next: string | null | undefined, path: string, search = ""): string | null {
  if (next !== "aal2" || current === "aal2") return null;
  if (path === "/mfa" || path === "/login" || path.startsWith("/api/") || path.startsWith("/capture/") || path.startsWith("/quote/") || path.startsWith("/u/") || path.startsWith("/book/") || path.startsWith("/m/")) return null;
  return `/mfa?next=${encodeURIComponent(safeNext(path + search))}`;
}
