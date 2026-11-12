import { createHmac } from "node:crypto";

/** True for loopback, private, link-local, carrier-NAT, multicast and other non-public addresses. */
export function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]!);
  if (v.includes(":")) {
    return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff") || v.startsWith("2001:db8");
  }
  const p = v.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // unparseable: refuse
  const [a, b] = p as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}

/** Static checks on a webhook URL. The dispatcher also checks the resolved address at send time. */
export function isSafeWebhookUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!h.includes(".") && !h.includes(":")) return false;          // bare names like "localhost" or "intranet"
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(h)) return false;
  if (/^[\d.]+$/.test(h) || h.includes(":")) return !isPrivateIp(h); // IP literals only if public
  return true;
}

/** Signature = HMAC-SHA256(secret, `${timestamp}.${body}`). Receivers should reject old timestamps. */
export function signPayload(secret: string, timestamp: number, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}
