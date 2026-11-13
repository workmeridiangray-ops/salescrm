import { NextResponse } from "next/server";
import { meetingIcs } from "@/lib/ics";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
const UUID = /^[0-9a-f-]{36}$/i;

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { data: m } = await (await createClient()).from("meetings").select("id, title, starts_at, ends_at, notes, attendee_email").eq("id", id).maybeSingle();   // RLS: only meetings the viewer may see
  if (!m) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(meetingIcs({ id: m.id, title: m.title, starts: new Date(m.starts_at), ends: new Date(m.ends_at), description: m.notes, attendeeEmail: m.attendee_email }),
    { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": `attachment; filename="meeting.ics"`, "cache-control": "no-store" } });
}
