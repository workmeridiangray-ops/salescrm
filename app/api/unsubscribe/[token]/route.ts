import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** RFC 8058 one-click unsubscribe: mail clients POST here without showing the page. */
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  await (await createClient()).rpc("unsubscribe", { p_token: token });
  return new NextResponse(null, { status: 200 });
}
