export const SCOPES = ["read:accounts", "read:contacts", "read:leads", "read:opportunities", "write:leads"] as const;
export const EVENTS = ["lead.created", "opportunity.won", "quote.accepted"] as const;

export function bearerToken(header: string | null): string | null {
  const m = header?.match(/^Bearer\s+(sk_live_[0-9a-f]{64})$/);
  return m ? m[1]! : null;
}

/** Map database error text to an HTTP response for the public API. */
export function apiStatus(message: string): { status: number; code: string } {
  if (/unauthorized/.test(message)) return { status: 401, code: "unauthorized" };
  if (/insufficient_scope/.test(message)) return { status: 403, code: "insufficient_scope" };
  if (/rate_limited/.test(message)) return { status: 429, code: "rate_limited" };
  if (/unknown_entity/.test(message)) return { status: 404, code: "unknown_entity" };
  if (/invalid_lead/.test(message)) return { status: 422, code: "invalid_lead" };
  return { status: 500, code: "server_error" };
}
