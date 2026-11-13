import { beforeAll, describe, expect, it } from "vitest";
import { as, failure, ids, seed, switchTo, U, type Q } from "./helpers";

beforeAll(seed);

/** Availability every day 00:00-23:00 UTC so tests don't depend on the weekday. */
async function open(q: Q, opts: { duration?: number; buffer?: number; notice?: number; window?: number; slug?: string } = {}) {
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "00:00", end: "23:00" }));
  await q("select set_availability($1, $2::jsonb)", [ids.acme, JSON.stringify(rules)]);
  await q("insert into booking_links (tenant_id, slug, title, duration_min, buffer_min, notice_hours, window_days, tz) values ($1, $2, 'Intro call', $3, $4, $5, $6, 'UTC')",
    [ids.acme, opts.slug ?? "owner-intro", opts.duration ?? 30, opts.buffer ?? 0, opts.notice ?? 1, opts.window ?? 7]);
}
const slots = async (q: Q, slug = "owner-intro") => ((await q("select booking_slots($1, 7) s", [slug]))[0]!.s?.slots ?? []) as string[];
const anon = async (q: Q) => { await switchTo(q, "owner"); await q("set local role anon"); };
const book = (q: Q, at: string, email = "buyer@x.test", slug = "owner-intro") => q("select book_slot($1, $2, 'Priya Rao', $3, 'hi') r", [slug, at, email]).then((r) => r[0]!.r);

describe("slots", () => {
  it("offers a grid inside availability, after the notice period and inside the window, newest data first", async () => {
    await as("ownerA", async (q) => {
      await open(q, { notice: 24, window: 3 });
      await anon(q);
      const s = await slots(q);
      expect(s.length).toBeGreaterThan(40);
      const first = new Date(s[0]!).getTime();
      expect(first).toBeGreaterThanOrEqual(Date.now() + 24 * 3600 * 1000 - 1000);
      expect(new Date(s[s.length - 1]!).getTime()).toBeLessThanOrEqual(Date.now() + 3 * 86400 * 1000);
      expect(s.every((x) => new Date(x).getUTCMinutes() % 30 === 0)).toBe(true);
      expect(s.every((x) => new Date(x).getUTCHours() < 23)).toBe(true);
    });
  });
  it("hides booked times and honours buffers; inactive or unknown links reveal nothing", async () => {
    await as("ownerA", async (q) => {
      await open(q, { buffer: 15, notice: 0 });
      await anon(q);
      const before = await slots(q);
      const target = before[10]!;
      await book(q, target);
      const after = await slots(q);
      const t = new Date(target).getTime();
      expect(after).not.toContain(target);
      // 15 min buffer: the neighbours on BOTH sides are lost too (the slot before would run into the booking through its own buffer)
      const iso = (ms: number) => new Date(ms).toISOString();
      expect(after.map((x) => iso(new Date(x).getTime()))).not.toContain(iso(t + 30 * 60000));
      expect(after.map((x) => iso(new Date(x).getTime()))).not.toContain(iso(t - 30 * 60000));
      expect(after.length).toBe(before.length - 3);
      expect((await q("select booking_slots('no-such-link') s"))[0]!.s).toBeNull();
      await switchTo(q, "ownerA");
      await q("update booking_links set active = false");
      await anon(q);
      expect((await q("select booking_slots('owner-intro') s"))[0]!.s).toBeNull();
    });
  });
});

describe("booking", () => {
  it("creates the meeting, links or creates the contact, logs it and returns a manage token stored hashed", async () => {
    await as("ownerA", async (q) => {
      await open(q, { notice: 0 });
      await anon(q);
      const at = (await slots(q))[5]!;
      const r = await book(q, at);
      expect(r.token).toMatch(/^[0-9a-f]{64}$/);
      await switchTo(q, "ownerA");
      const m = (await q("select source, status, attendee_email, manage_token_hash, contact_id from meetings"))[0]!;
      expect(m).toMatchObject({ source: "booking", status: "scheduled", attendee_email: "buyer@x.test" });
      expect(m.manage_token_hash).not.toContain(r.token);
      expect((await q("select full_name, source, owner_id from contacts where email = 'buyer@x.test'"))[0]).toEqual({ full_name: "Priya Rao", source: "web", owner_id: U.ownerA });
      expect((await q("select subject from activities where contact_id = $1", [m.contact_id]))[0]!.subject).toBe("Booked: Intro call");
    });
  });
  it("links an existing contact instead of duplicating it", async () => {
    await as("ownerA", async (q) => {
      await open(q, { notice: 0 });
      await q("insert into contacts (tenant_id, full_name, email, owner_id) values ($1, 'Priya (existing)', 'known@x.test', $2)", [ids.acme, U.ownerA]);
      await anon(q);
      await book(q, (await slots(q))[3]!, "known@x.test");
      await switchTo(q, "ownerA");
      expect(await q("select 1 from contacts where email = 'known@x.test'")).toHaveLength(1);
    });
  });
  it("rejects off-grid, out-of-availability, past, already-taken and over-window times; double-booking races end as 'slot_taken'", async () => {
    await as("ownerA", async (q) => {
      await open(q, { notice: 2, window: 2 });
      await anon(q);
      const s = await slots(q);
      const off = new Date(new Date(s[4]!).getTime() + 7 * 60000).toISOString();
      for (const bad of [off, new Date(Date.now() - 3600000).toISOString(), new Date(Date.now() + 5 * 86400000).toISOString(), new Date(Date.now() + 3600000).toISOString()])
        expect(await failure(book(q, bad)), bad).toBe("slot_taken");
      await book(q, s[4]!);
      expect(await failure(book(q, s[4]!, "other@x.test"))).toBe("slot_taken");
    });
  });
  it("validates input, caps upcoming bookings per person, and refuses suspended workspaces", async () => {
    await as("ownerA", async (q) => {
      await open(q, { notice: 0 });
      await anon(q);
      const s = await slots(q);
      expect(await failure(q("select book_slot('owner-intro', $1, '', 'a@b.test', null)", [s[0]!]))).toBe("invalid_request");
      expect(await failure(q("select book_slot('owner-intro', $1, 'N', 'not-an-email', null)", [s[0]!]))).toBe("invalid_request");
      for (let i = 0; i < 3; i++) await book(q, s[i * 2]!);
      expect(await failure(book(q, s[8]!))).toBe("too_many_bookings");
      await switchTo(q, "owner");
      await q("update tenants set status = 'suspended' where id = $1", [ids.acme]);
      await q("set local role anon");
      expect(await failure(book(q, s[10]!, "z@x.test"))).toBe("booking_unavailable");
    });
  });
});

describe("conflicts and lifecycle", () => {
  it("manual meetings cannot overlap each other or a booking, buffer included - enforced by the database", async () => {
    await as("ownerA", async (q) => {
      const at = "2030-01-07T10:00:00Z";
      const mk = (s: string, e: string, buf = 0, owner: string = U.ownerA) => q("insert into meetings (tenant_id, owner_id, title, starts_at, ends_at, buffer_min) values ($1, $4, 'M', $2, $3, $5)", [ids.acme, s, e, owner, buf]);
      await mk(at, "2030-01-07T11:00:00Z", 15);
      expect(await failure(mk("2030-01-07T10:30:00Z", "2030-01-07T11:30:00Z"))).toMatch(/meetings_no_overlap/);
      expect(await failure(mk("2030-01-07T11:10:00Z", "2030-01-07T11:40:00Z"))).toMatch(/meetings_no_overlap/);   // inside the 15 min buffer
      await mk("2030-01-07T11:15:00Z", "2030-01-07T11:45:00Z");                                                   // right after the buffer: fine
      await switchTo(q, "owner");
      await mk(at, "2030-01-07T11:00:00Z", 0, U.managerA);                                                          // a different person: fine
    });
  });
  it("cancelling frees the slot; finished meetings are frozen; outcomes can be recorded", async () => {
    await as("ownerA", async (q) => {
      const id = (await q("insert into meetings (tenant_id, title, starts_at, ends_at) values ($1, 'M', '2030-01-08T10:00Z', '2030-01-08T11:00Z') returning id", [ids.acme]))[0]!.id;
      await q("update meetings set status = 'cancelled' where id = $1", [id]);
      await q("insert into meetings (tenant_id, title, starts_at, ends_at) values ($1, 'Replacement', '2030-01-08T10:00Z', '2030-01-08T11:00Z')", [ids.acme]);
      expect(await failure(q("update meetings set status = 'scheduled' where id = $1", [id]))).toMatch(/meeting_closed/);
      const done = (await q("insert into meetings (tenant_id, title, starts_at, ends_at) values ($1, 'D', '2030-01-09T10:00Z', '2030-01-09T11:00Z') returning id", [ids.acme]))[0]!.id;
      await q("update meetings set status = 'completed', outcome = 'Wants a quote' where id = $1", [done]);
      expect((await q("select outcome from meetings where id = $1", [done]))[0]!.outcome).toBe("Wants a quote");
      expect(await failure(q("update meetings set starts_at = '2030-02-01T10:00Z', ends_at = '2030-02-01T11:00Z' where id = $1", [done]))).toMatch(/meeting_closed/);
    });
  });
  it("attendees can view and cancel with their link only; future meetings only; repeat or wrong tokens do nothing", async () => {
    await as("ownerA", async (q) => {
      await open(q, { notice: 0 });
      await anon(q);
      const r = await book(q, (await slots(q))[2]!);
      const v = (await q("select meeting_for_token($1) m", [r.token]))[0]!.m;
      expect(v).toMatchObject({ status: "scheduled", can_cancel: true, company: "Acme Distribution", slug: "owner-intro" });
      expect((await q("select meeting_for_token('nope') m"))[0]!.m).toBeNull();
      expect((await q("select cancel_meeting_by_token('nope') ok"))[0]!.ok).toBe(false);
      expect((await q("select cancel_meeting_by_token($1) ok", [r.token]))[0]!.ok).toBe(true);
      expect((await q("select cancel_meeting_by_token($1) ok", [r.token]))[0]!.ok).toBe(false);
      expect((await slots(q))).toContain(r.starts_at.replace("Z", "+00:00").replace(/\.000/, ""));   // the slot is offered again
    });
  });
  it("meetings follow record visibility: staff see their own only, other workspaces see nothing", async () => {
    await as("ownerA", async (q) => {
      await q("insert into meetings (tenant_id, title, starts_at, ends_at) values ($1, 'Owner only', '2030-03-01T10:00Z', '2030-03-01T11:00Z')", [ids.acme]);
      await switchTo(q, "staffA");
      expect(await q("select 1 from meetings")).toHaveLength(0);
      await switchTo(q, "managerA");
      expect(await q("select 1 from meetings")).toHaveLength(1);
      await switchTo(q, "ownerB");
      expect(await q("select 1 from meetings")).toHaveLength(0);
      expect(await failure(q("insert into meetings (tenant_id, title, starts_at, ends_at) values ($1, 'x', '2030-03-01T10:00Z', '2030-03-01T11:00Z')", [ids.acme]))).toMatch(/row-level security|foreign key/);
    });
  });
  it("only the owner edits their availability, and only their own", async () => {
    await as("staffA", async (q) => {
      await q("select set_availability($1, '[{\"weekday\":1,\"start\":\"09:00\",\"end\":\"12:00\"}]'::jsonb)", [ids.acme]);
      expect(await failure(q("select set_availability($1, '[{\"weekday\":9,\"start\":\"09:00\",\"end\":\"12:00\"}]'::jsonb)", [ids.acme]))).toMatch(/check/);
      expect(await failure(q("select set_availability($1, '[{\"weekday\":1,\"start\":\"12:00\",\"end\":\"09:00\"}]'::jsonb)", [ids.acme]))).toMatch(/check/);
      await switchTo(q, "ownerA");
      await q("select set_availability($1, '[]'::jsonb)", [ids.acme]);
      await switchTo(q, "owner");
      expect(await q("select 1 from availability_rules where user_id = $1", [U.staffA])).toHaveLength(1);
    });
  });
});
