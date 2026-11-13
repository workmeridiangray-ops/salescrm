import { describe, expect, it } from "vitest";
import { meetingIcs } from "./ics";

describe("meetingIcs", () => {
  const base = { id: "abc", title: "Intro; call, with\nnewline", starts: new Date("2030-01-07T10:00:00Z"), ends: new Date("2030-01-07T10:30:00Z") };
  it("writes valid UTC times, escapes text and ends every line with CRLF", () => {
    const s = meetingIcs({ ...base, description: "Bring slides" });
    expect(s).toContain("DTSTART:20300107T100000Z");
    expect(s).toContain("DTEND:20300107T103000Z");
    expect(s).toContain("SUMMARY:Intro\; call\\, with\\nnewline");
    expect(s.split("\r\n").every((l, i, a) => i === a.length - 1 || l.length <= 75)).toBe(true);
    expect(s.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
  it("only includes an attendee that looks like a plain email (no header injection)", () => {
    expect(meetingIcs({ ...base, attendeeEmail: "a@b.test" })).toContain("ATTENDEE:mailto:a@b.test");
    expect(meetingIcs({ ...base, attendeeEmail: "a@b.test\r\nX-EVIL:1" })).not.toContain("ATTENDEE");
  });
  it("folds long lines", () => {
    const s = meetingIcs({ ...base, title: "x".repeat(200) });
    expect(s).toContain("\r\n x");
  });
});
