import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getWorkspace } from "@/lib/workspace";
import { Empty, Hidden, Notice } from "@/components/ui";
import { addActivity, completeActivity, setNextAction } from "../actions";

export const metadata: Metadata = { title: "Today" };

export default async function Today({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { tenant, user } = await getWorkspace(slug);
  const supabase = await createClient();
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
  const [{ data: due }, { data: noNext }] = await Promise.all([
    supabase.from("activities").select("id, subject, kind, due_at, opportunity_id").eq("tenant_id", tenant.id).eq("owner_id", user.id)
      .is("done_at", null).lte("due_at", endOfToday.toISOString()).order("due_at").limit(100),
    supabase.from("opportunities").select("id, name, amount").eq("tenant_id", tenant.id).eq("owner_id", user.id)
      .eq("status", "open").is("archived_at", null).is("next_action", null).limit(50),
  ]);
  const now = Date.now();
  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">Today</h1>
      <Notice error={sp.error} ok={sp.ok} />
      <div>
        <h2 className="text-lg font-semibold">Due and overdue</h2>
        {(due ?? []).length === 0 ? <Empty>Nothing due. Add a follow-up below.</Empty> : (
          <ul className="mt-2 space-y-2">
            {(due ?? []).map((a) => (
              <li key={a.id} className="card flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium">{a.subject}</span>{" "}
                  <span className="text-sm text-muted">{a.kind} · {a.due_at && new Date(a.due_at).getTime() < now ? <strong className="text-red-700">overdue</strong> : "today"}</span>
                </span>
                <form action={completeActivity} className="flex gap-2">
                  <Hidden name="slug" value={slug} /><Hidden name="id" value={a.id} />
                  <input className="input w-48" name="outcome" placeholder="Outcome (optional)" aria-label="Outcome" />
                  <button className="btn-quiet">Done</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
      <form action={addActivity} className="card flex flex-wrap items-end gap-3">
        <Hidden name="slug" value={slug} /><Hidden name="tenant" value={tenant.id} /><Hidden name="kind" value="task" />
        <label className="text-sm font-medium">Follow-up<input className="input mt-1" name="subject" required maxLength={200} /></label>
        <label className="text-sm font-medium">Due<input className="input mt-1" type="datetime-local" name="due_at" /></label>
        <button className="btn">Add task</button>
      </form>
      <div>
        <h2 className="text-lg font-semibold">Opportunities without a next action</h2>
        {(noNext ?? []).length === 0 ? <Empty>Every open opportunity has a next step.</Empty> : (
          <ul className="mt-2 space-y-2">
            {(noNext ?? []).map((o) => (
              <li key={o.id} className="card">
                <p className="font-medium">{o.name}</p>
                <form action={setNextAction} className="mt-2 flex flex-wrap gap-2">
                  <Hidden name="slug" value={slug} /><Hidden name="id" value={o.id} /><Hidden name="back" value="today" />
                  <input className="input max-w-xs" name="next_action" placeholder="Next action" required aria-label="Next action" />
                  <input className="input w-40" type="date" name="next_action_due" required aria-label="Due date" />
                  <button className="btn-quiet">Save</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
