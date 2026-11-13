import { describe, expect, it } from "vitest";
import { buildOutreach, unsubscribeUrl } from "./outreach-email";

describe("buildOutreach", () => {
  it("escapes the body, keeps paragraphs and always includes the unsubscribe link and headers", () => {
    const m = buildOutreach('Hi <b>Asha</b> & team\nline two\n\nSecond "para"', "https://app.test/u/tok", "Owner <x>");
    expect(m.html).toContain("Hi &lt;b&gt;Asha&lt;/b&gt; &amp; team<br>line two");
    expect(m.html).toContain("<p>Second &quot;para&quot;</p>");
    expect(m.html).toContain('<a href="https://app.test/u/tok">Unsubscribe</a>');
    expect(m.html).toContain("Sent by Owner &lt;x&gt;");
    expect(m.text).toContain("Unsubscribe: https://app.test/u/tok");
    expect(m.headers["List-Unsubscribe"]).toBe("<https://app.test/u/tok>");
    expect(m.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
  it("cannot be tricked into a script or attribute break via the URL", () => {
    expect(buildOutreach("x", 'https://a.test/u/"><script>', "").html).not.toContain("<script>");
  });
  it("uses a separate one-click endpoint for the header when given", () => {
    const m = buildOutreach("x", "https://a.test/u/t", undefined, "https://a.test/api/unsubscribe/t");
    expect(m.headers["List-Unsubscribe"]).toBe("<https://a.test/api/unsubscribe/t>");
    expect(m.html).toContain("https://a.test/u/t");
  });
  it("builds links without double slashes", () => expect(unsubscribeUrl("https://app.test/", "t")).toBe("https://app.test/u/t"));
});
