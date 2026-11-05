import { describe, expect, it } from "vitest";
import { escapeHtml, invitationEmail } from "./email-templates";

describe("invitationEmail", () => {
  it("escapes user-controlled text and strips line breaks from the subject", () => {
    const m = invitationEmail({ workspace: "<script>x</script>", inviter: "A\r\nBcc: evil@x.test", link: 'https://a.test/i/"><b>' });
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain('"><b>');
    expect(m.subject).not.toMatch(/[\r\n]/);
  });
  it("escapeHtml handles all five characters", () => expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;"));
});
