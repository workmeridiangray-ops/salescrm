import { beforeAll, describe, expect, it } from "vitest";
import { as, failure, ids, seed, switchTo, U, type Q } from "./helpers";

beforeAll(seed);

/** A 3-step sequence: email, task after 1 day, email after 2 more days. Activated by the manager. */
async function setup(q: Q, opts: { tz?: string; window?: [string, string]; limit?: number } = {}) {
  const seq = (await q("insert into sequences (tenant_id, name, daily_limit, window_start, window_end, tz) values ($1, 'Intro', $2, $3, $4, $5) returning id",
    [ids.acme, opts.limit ?? 50, opts.window?.[0] ?? "00:00", opts.window?.[1] ?? "23:59:59", opts.tz ?? "UTC"]))[0]!.id as string;
  const step = (pos: number, kind: string, delay: number, subject: string, body = "Hi {{first_name}} at {{company}}") =>
    q("insert into sequence_steps (tenant_id, sequence_id, position, kind, delay_days, subject, body) values ($1, $2, $3, $4, $5, $6, $7)", [ids.acme, seq, pos, kind, delay, subject, body]);
  await step(0, "email", 0, "Hello {{first_name}}"); await step(1, "task", 1, "Call {{first_name}}", ""); await step(2, "email", 2, "Following up");
  return seq;
}
const contact = async (q: Q, name: string, email: string | null, owner: string = U.ownerA, account: string | null = null) =>
  (await q("insert into contacts (tenant_id, full_name, email, owner_id, account_id) values ($1, $2, $3, $4, $5) returning id", [ids.acme, name, email, owner, account]))[0]!.id as string;
const activate = async (q: Q, seq: string) => { await switchTo(q, "managerA"); await q("select set_sequence_status($1, 'active')", [seq]); await switchTo(q, "ownerA"); };
const claim = async (q: Q, n = 20) => { await switchTo(q, "owner"); await q("set local role service_role"); const r = await q("select * from sequence_claim_due($1)", [n]); await q("reset role"); return r; };
const report = async (q: Q, id: number | string, ok: boolean, err: string | null = null) => { await switchTo(q, "owner"); await q("set local role service_role"); await q("select sequence_report_send($1, $2, 'msg-1', $3)", [id, ok, err]); await q("reset role"); };
const due = async (q: Q) => { await switchTo(q, "owner"); await q("update enrolments set next_step_at = now() - interval '1 minute' where status = 'active'"); await switchTo(q, "ownerA"); };
const enrol = async (q: Q, seq: string) => (await q("select status, stop_reason, current_step from enrolments where sequence_id = $1 order by created_at", [seq]));

describe("approval and editing", () => {
  it("staff can build but not activate; steps freeze after activation; empty or email-less plans cannot start", async () => {
    await as("staffA", async (q) => {
      const seq = (await q("insert into sequences (tenant_id, name) values ($1, 'S') returning id", [ids.acme]))[0]!.id;
      expect(await failure(q("select set_sequence_status($1, 'active')", [seq]))).toBe("forbidden");
      await switchTo(q, "managerA");
      expect(await failure(q("select set_sequence_status($1, 'active')", [seq]))).toBe("sequence_empty");
      await q("insert into sequence_steps (tenant_id, sequence_id, position, kind, subject) values ($1, $2, 0, 'task', 'only a task')", [ids.acme, seq]);
      expect(await failure(q("select set_sequence_status($1, 'active')", [seq]))).toBe("sequence_needs_email");
      await q("insert into sequence_steps (tenant_id, sequence_id, position, kind, subject, body) values ($1, $2, 1, 'email', 'e', 'b')", [ids.acme, seq]);
      await q("select set_sequence_status($1, 'active')", [seq]);
      expect(await failure(q("insert into sequence_steps (tenant_id, sequence_id, position, kind, subject, body) values ($1, $2, 2, 'email', 'x', 'y')", [ids.acme, seq]))).toMatch(/sequence_locked/);
      expect(await failure(q("delete from sequence_steps where sequence_id = $1", [seq]))).toMatch(/sequence_locked/);
      expect((await q("select activated_by from sequences where id = $1", [seq]))[0]!.activated_by).toBe(U.managerA);
    });
  });
  it("email steps need a body; delays are bounded; other workspaces see nothing", async () => {
    await as("ownerA", async (q) => {
      const seq = (await q("insert into sequences (tenant_id, name) values ($1, 'S') returning id", [ids.acme]))[0]!.id;
      expect(await failure(q("insert into sequence_steps (tenant_id, sequence_id, position, kind, subject, body) values ($1, $2, 0, 'email', 's', '')", [ids.acme, seq]))).toMatch(/check/);
      expect(await failure(q("insert into sequence_steps (tenant_id, sequence_id, position, kind, delay_days, subject, body) values ($1, $2, 0, 'email', 61, 's', 'b')", [ids.acme, seq]))).toMatch(/check/);
      await switchTo(q, "ownerB");
      expect(await q("select 1 from sequences")).toHaveLength(0);
    });
  });
});

describe("enrolment", () => {
  it("previews counts, then enrols only eligible, visible contacts; enrolling needs an active sequence", async () => {
    await as("ownerA", async (q) => {
      const seq = await setup(q);
      const ok = await contact(q, "Asha Rao", "asha@x.test"), none = await contact(q, "No Mail", null), out = await contact(q, "Opted", "o@x.test");
      await q("update contacts set opted_out = true where id = $1", [out]);
      const sup = await contact(q, "Supp", "sup@x.test");
      await q("select add_suppression($1, 'sup@x.test', 'bounced')", [ids.acme]).catch(() => undefined);
      await switchTo(q, "managerA");
      await q("select add_suppression($1, 'sup@x.test', 'bounced')", [ids.acme]);
      await switchTo(q, "ownerA");
      const theirs = await contact(q, "Not Mine", "nm@x.test", U.managerA);
      await switchTo(q, "staffA");
      const mine = await contact(q, "Staff Own", "so@x.test", U.staffA);
      await switchTo(q, "ownerA");
      expect(await failure(q("select enrol_contacts($1, $2)", [seq, [ok]]))).toBe("sequence_not_active");
      const pv = (await q("select preview_enrolment($1, $2) p", [seq, [ok, none, out, sup, theirs, mine]]))[0]!.p;
      expect(pv).toMatchObject({ selected: 6, eligible: 3, no_email: 1, opted_out: 1, suppressed: 1 });
      await activate(q, seq);
      expect((await q("select enrol_contacts($1, $2) n", [seq, [ok, none, out, sup, theirs, mine]]))[0]!.n).toBe(3);
      expect((await q("select enrol_contacts($1, $2) n", [seq, [ok]]))[0]!.n).toBe(0);   // already enrolled
    });
  });
  it("staff cannot enrol contacts they don't own", async () => {
    await as("ownerA", async (q) => {
      const seq = await setup(q); const c = await contact(q, "Owner's", "own@x.test", U.ownerA);
      await activate(q, seq);
      await switchTo(q, "staffA");
      expect((await q("select enrol_contacts($1, $2) n", [seq, [c]]))[0]!.n).toBe(0);
    });
  });
});

describe("sending", () => {
  it("runs step by step: email, then a task for the owner, then the last email, then completes; tokens are filled in", async () => {
    await as("ownerA", async (q) => {
      const seq = await setup(q);
      const acct = (await q("insert into accounts (tenant_id, name) values ($1, 'BigCo') returning id", [ids.acme]))[0]!.id;
      const c = await contact(q, "Asha Rao", "asha@x.test", U.ownerA, acct);
      await activate(q, seq); await q("select enrol_contacts($1, $2)", [seq, [c]]);
      await due(q);
      let r = await claim(q);
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ to_email: "asha@x.test", subject: "Hello Asha", body: "Hi Asha at BigCo", reply_to: "owner@acme.test" });
      expect(r[0]!.unsub_token).toMatch(/^[0-9a-f]{64}$/);
      expect(await claim(q)).toHaveLength(0);                       // leased: not sent twice while in flight
      await report(q, r[0]!.outbound_id, true);
      expect((await enrol(q, seq))[0]).toMatchObject({ status: "active", current_step: 1 });
      await due(q); expect(await claim(q)).toHaveLength(0);          // task step produces no email...
      expect((await q("select subject, owner_id from activities where kind = 'task' and contact_id = $1", [c]))[0]).toEqual({ subject: "Call Asha", owner_id: U.ownerA });
      expect((await enrol(q, seq))[0]!.current_step).toBe(2);
      await due(q); r = await claim(q);
      expect(r[0]!.subject).toBe("Following up");
      await report(q, r[0]!.outbound_id, true);
      expect((await enrol(q, seq))[0]).toMatchObject({ status: "completed" });
    });
  });
  it("waits for the delay, the sending window and the daily cap", async () => {
    await as("ownerA", async (q) => {
      const closed = await setup(q, { window: ["03:00", "03:01"] });   // practically always closed
      const c1 = await contact(q, "A", "a@x.test");
      await activate(q, closed); await q("select enrol_contacts($1, $2)", [closed, [c1]]); await due(q);
      expect(await claim(q)).toHaveLength(0);
      expect((await enrol(q, closed))[0]).toMatchObject({ status: "active", current_step: 0 });
    });
    await as("ownerA", async (q) => {
      const capped = await setup(q, { limit: 2 });
      const cs = [await contact(q, "A", "a@x.test"), await contact(q, "B", "b@x.test"), await contact(q, "C", "c@x.test")];
      await activate(q, capped); await q("select enrol_contacts($1, $2)", [capped, cs]); await due(q);
      expect(await claim(q)).toHaveLength(2);
    });
    await as("ownerA", async (q) => {
      const seq = await setup(q); const c = await contact(q, "A", "a@x.test");
      await activate(q, seq); await q("select enrol_contacts($1, $2)", [seq, [c]]);
      await switchTo(q, "owner"); await q("update sequence_steps set delay_days = 0 where sequence_id = $1", [seq]).catch(() => undefined);
      await q("update enrolments set next_step_at = now() + interval '1 hour'");
      expect(await claim(q)).toHaveLength(0);                       // not due yet
    });
  });
  it("failures retry later, and a step that fails 3 times stops the enrolment", async () => {
    await as("ownerA", async (q) => {
      const seq = await setup(q); const c = await contact(q, "A", "a@x.test");
      await activate(q, seq); await q("select enrol_contacts($1, $2)", [seq, [c]]);
      for (let i = 1; i <= 3; i++) {
        await due(q);
        const r = await claim(q); expect(r).toHaveLength(1);
        await report(q, r[0]!.outbound_id, false, "smtp down");
        expect((await enrol(q, seq))[0]!.status).toBe(i < 3 ? "active" : "stopped");
      }
      expect((await enrol(q, seq))[0]).toMatchObject({ stop_reason: "send_failed" });
    });
  });
  it("only the service role can claim or report", async () => {
    await as("ownerA", async (q) => {
      expect(await failure(q("select * from sequence_claim_due(5)"))).toMatch(/permission denied/);
      expect(await failure(q("select sequence_report_send(1, true, 'x', null)"))).toMatch(/permission denied/);
    });
  });
});

describe("stop rules", () => {
  async function running(q: Q, email = "asha@x.test") {
    const seq = await setup(q); const c = await contact(q, "Asha Rao", email);
    await activate(q, seq); await q("select enrol_contacts($1, $2)", [seq, [c]]); await due(q);
    return { seq, c };
  }
  it("a reply stops every sequence for that contact and logs it", async () => {
    await as("ownerA", async (q) => {
      const { seq, c } = await running(q);
      const seq2 = await setup(q); await switchTo(q, "managerA"); await q("select set_sequence_status($1, 'active')", [seq2]); await switchTo(q, "ownerA");
      await q("select enrol_contacts($1, $2)", [seq2, [c]]);
      expect((await q("select mark_replied($1) n", [c]))[0]!.n).toBe(2);
      expect((await enrol(q, seq))[0]).toMatchObject({ status: "stopped", stop_reason: "replied" });
      expect(await claim(q)).toHaveLength(0);
      expect((await q("select subject from activities where contact_id = $1 and kind = 'email'", [c]))[0]!.subject).toBe("Replied to outreach");
    });
  });
  it("unsubscribing (public link) suppresses, opts out and stops - and suppression is checked again at send time", async () => {
    await as("ownerA", async (q) => {
      const { seq, c } = await running(q);
      const r = await claim(q);
      const tok = r[0]!.unsub_token as string;
      await report(q, r[0]!.outbound_id, true);
      await switchTo(q, "owner");
      const seq2 = await setup(q); await switchTo(q, "managerA"); await q("select set_sequence_status($1, 'active')", [seq2]); await switchTo(q, "ownerA");
      await q("select enrol_contacts($1, $2)", [seq2, [c]]);
      await switchTo(q, "owner"); await q("update enrolments set next_step_at = now() - interval '1 minute' where status = 'active'");
      await q("set local role anon");
      expect((await q("select unsubscribe('wrong-token') ok"))[0]!.ok).toBe(false);
      expect((await q("select unsubscribe($1) ok", [tok]))[0]!.ok).toBe(true);
      expect((await q("select unsubscribe($1) ok", [tok]))[0]!.ok).toBe(true);   // idempotent
      await q("reset role");
      expect((await q("select reason from email_suppressions where email = 'asha@x.test'"))[0]!.reason).toBe("unsubscribed");
      expect((await q("select opted_out from contacts where id = $1", [c]))[0]!.opted_out).toBe(true);
      expect((await q("select distinct stop_reason from enrolments where contact_id = $1", [c])).map((x) => x.stop_reason)).toEqual(["unsubscribed"]);
      expect(await claim(q)).toHaveLength(0);
      void seq;
    });
  });
  it("a suppression added AFTER enrolment still blocks the next send", async () => {
    await as("ownerA", async (q) => {
      const { seq } = await running(q, "late@x.test");
      await switchTo(q, "owner");
      await q("insert into email_suppressions (tenant_id, email, reason) values ($1, 'late@x.test', 'complaint')", [ids.acme]);
      expect(await claim(q)).toHaveLength(0);
      expect((await enrol(q, seq))[0]).toMatchObject({ status: "stopped", stop_reason: "unsubscribed" });
    });
  });
  it("opting a contact out, archiving it, or the owner leaving stops the sequence; reassigning moves it instead", async () => {
    await as("ownerA", async (q) => {
      const a = await running(q, "a@x.test");
      await q("update contacts set opted_out = true where id = $1", [a.c]);
      expect((await enrol(q, a.seq))[0]).toMatchObject({ stop_reason: "opted_out" });
      const b = await running(q, "b@x.test");
      await q("update contacts set archived_at = now() where id = $1", [b.c]);
      expect((await enrol(q, b.seq))[0]).toMatchObject({ stop_reason: "contact_archived" });
    });
    await as("managerA", async (q) => {
      const seq = await setup(q); const c = await contact(q, "Leaver's", "lv@x.test", U.staffA);
      await q("select set_sequence_status($1, 'active')", [seq]);
      await switchTo(q, "staffA"); await q("select enrol_contacts($1, $2)", [seq, [c]]);
      await switchTo(q, "managerA"); await due(q);
      await switchTo(q, "owner"); await q("update memberships set status = 'suspended' where user_id = $1", [U.staffA]);
      expect(await claim(q)).toHaveLength(0);
      expect((await enrol(q, seq))[0]).toMatchObject({ stop_reason: "owner_left" });
    });
    await as("managerA", async (q) => {
      const seq = await setup(q); const c = await contact(q, "Moved", "mv@x.test", U.staffA);
      await q("select set_sequence_status($1, 'active')", [seq]);
      await switchTo(q, "staffA"); await q("select enrol_contacts($1, $2)", [seq, [c]]);
      await switchTo(q, "managerA");
      expect((await q("select reassign_records($1, $2, $3) r", [ids.acme, U.staffA, U.managerA]))[0]!.r.sequence_enrolments).toBe(1);
      expect((await q("select owner_id from enrolments where sequence_id = $1", [seq]))[0]!.owner_id).toBe(U.managerA);
      await due(q);
      expect(await claim(q)).toHaveLength(1);
    });
  });
  it("a paused sequence and a suspended workspace send nothing", async () => {
    await as("ownerA", async (q) => {
      const { seq } = await running(q);
      await switchTo(q, "managerA"); await q("select set_sequence_status($1, 'paused')", [seq]);
      expect(await claim(q)).toHaveLength(0);
      await q("select set_sequence_status($1, 'active')", [seq]);
      await switchTo(q, "owner"); await q("update tenants set status = 'suspended' where id = $1", [ids.acme]);
      expect(await claim(q)).toHaveLength(0);
    });
  });
});

describe("visibility and stats", () => {
  it("stats count outcomes; staff see only their own enrolments; suppression list is for approvers; no cross-workspace leakage", async () => {
    await as("ownerA", async (q) => {
      const seq = await setup(q); const c = await contact(q, "A", "a@x.test");
      await activate(q, seq); await q("select enrol_contacts($1, $2)", [seq, [c]]); await due(q);
      const r = await claim(q); await report(q, r[0]!.outbound_id, true);
      await switchTo(q, "ownerA"); await q("select mark_replied($1)", [c]);
      const st = (await q("select sequence_stats($1) s", [seq]))[0]!.s;
      expect(st).toMatchObject({ enrolled: 1, emails_sent: 1, stopped: { replied: 1 } });
      await switchTo(q, "staffA");
      expect(await q("select 1 from enrolments")).toHaveLength(0);
      expect(await q("select 1 from email_suppressions")).toHaveLength(0);
      await switchTo(q, "ownerB");
      expect(await q("select 1 from enrolments")).toHaveLength(0);
      expect(await failure(q("select enrol_contacts($1, $2)", [seq, [c]]))).toBe("forbidden");
    });
  });
});
