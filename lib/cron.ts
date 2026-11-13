import { timingSafeEqual } from "node:crypto";

/** Scheduler endpoints require `Authorization: Bearer $CRON_SECRET`. No secret configured => always refuse. */
export function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/, "");
  const a = Buffer.from(given), b = Buffer.from(secret);
  return secret.length >= 16 && a.length === b.length && timingSafeEqual(a, b);
}
