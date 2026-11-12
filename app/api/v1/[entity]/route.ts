import { NextResponse } from "next/server";
import { apiStatus, bearerToken } from "@/lib/api-keys";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
const fail = (message: string) => {
  const { status, code } = apiStatus(message);
  return json({ error: code }, status, status === 429 ? { "retry-after": "60" } : {});
};

/** GET /api/v1/{accounts|contacts|leads|opportunities}?limit=50&after=<id>  with  Authorization: Bearer sk_live_… */
export async function GET(request: Request, { params }: { params: Promise<{ entity: string }> }) {
  const { entity } = await params;
  const key = bearerToken(request.headers.get("authorization"));
  if (!key) return json({ error: "unauthorized" }, 401);
  const url = new URL(request.url);
  const after = url.searchParams.get("after");
  if (after && !/^[0-9a-f-]{36}$/i.test(after)) return json({ error: "bad_cursor" }, 400);
  const limit = Math.max(1, Math.min(Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 200));
  const { data, error } = await (await createClient()).rpc("api_list", { p_key: key, p_entity: entity, p_limit: limit, p_after: after });
  if (error) return fail(error.message);
  return json(data);
}

/** POST /api/v1/leads {name, email?, company?, phone?, message?}  — needs the write:leads scope. */
export async function POST(request: Request, { params }: { params: Promise<{ entity: string }> }) {
  const { entity } = await params;
  if (entity !== "leads") return json({ error: "unknown_entity" }, 404);
  const key = bearerToken(request.headers.get("authorization"));
  if (!key) return json({ error: "unauthorized" }, 401);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.name !== "string") return json({ error: "invalid_lead" }, 422);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const { error } = await (await createClient()).rpc("api_create_lead", {
    p_key: key, p_name: body.name, p_email: str(body.email), p_company: str(body.company), p_phone: str(body.phone), p_message: str(body.message),
  });
  if (error) return fail(error.message);
  return json({ ok: true }, 202);   // accepted; duplicates are merged, so repeating a request is safe
}
