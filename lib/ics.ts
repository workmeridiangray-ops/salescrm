/** Minimal RFC 5545 calendar file for one meeting (import into any calendar app). */
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 73) { out.push(rest.slice(0, 73)); rest = " " + rest.slice(73); }
  out.push(rest);
  return out.join("\r\n");
}

export function meetingIcs(m: { id: string; title: string; starts: Date; ends: Date; description?: string | null; attendeeEmail?: string | null }): string {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sales CRM//Meetings//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    `UID:${m.id}@salescrm`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(m.starts)}`, `DTEND:${stamp(m.ends)}`,
    `SUMMARY:${esc(m.title)}`, ...(m.description ? [`DESCRIPTION:${esc(m.description)}`] : []),
    ...(m.attendeeEmail && /^[^\s@,;:]+@[^\s@,;:]+$/.test(m.attendeeEmail) ? [`ATTENDEE:mailto:${m.attendeeEmail}`] : []),
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
